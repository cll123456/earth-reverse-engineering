"use strict";

// Model 3 — densified octree, per-node DUAL-GEODE PagedLODs (no merging, no holes,
// bounded mesh sizes). Each internal octree node N becomes a PagedLOD wrapper whose
// children are EXTERNAL files (Option B — mesh/wrapper decoupling):
//
//   PagedLOD (UserCenter = N's own sphere, PIXEL_SIZE_ON_SCREEN, DatabasePath FALSE) {
//     <...>_complete.osgb   [0, T]      -> FAR: N's full mesh (all octants) — no hole
//     <...>_masked.osgb     [T, 1e30]   -> NEAR: N's mesh minus child octants
//     child entry files...  [T, 1e30]   -> NEAR: the real finer children
//   }
//
// The expensive part — osgconv'ing each node's complete/masked mesh into a geode osgb —
// is INDEPENDENT per node (no child dependency), so it runs incrementally as nodes are
// staged during streaming (see buildStagedGeodeJobs). The only thing that needs the
// global child set is the cheap, mesh-free wrapper, written at finalize once buildLodTree
// can resolve each node's children by nearest exported ancestor (finalizeDensifiedWrappers).
//
// Leaf nodes have no children, so their entry file IS a plain terminal geode (built during
// streaming). Internal nodes' entry file is the wrapper (built at finalize); their geodes
// live in the auxiliary _complete/_masked files. Either way osgbFileName(node) — the name a
// parent references — exists after finalize, so there are never dangling child references.
//
// Requires staged node.obj + _masked/node.obj (see prepareNodeStaging).

const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");
const { buildLodTree, readObjBounds, pixelRangeForLevel, writeTileRootOsgt, mergeIndexBounds } = require("./osgb-paged-lod");
const { stagingNodeDir } = require("./osgb-staging-writer");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./osgb-convert");
const { createAsyncPool, getDefaultConcurrency } = require("./async-pool");

// Async osgconv (non-blocking spawn) so the offline build pass can run many conversions
// in parallel. The streaming path converts through the stream-writer's osgb convert pool
// instead (sanitised + back-pressured); see submitStagedGeodes.
function runOsgConvAsync(args, cwd) {
	return new Promise((resolve, reject) => {
		const osgConvPath = findOsgConv();
		if (!osgConvPath) {
			reject(new Error("osgconv not found. Install OpenSceneGraph and ensure osgconv is on PATH."));
			return;
		}
		const proc = spawn(osgConvPath, [...OSGCONV_INLINE_TEXTURES, ...args], {
			cwd,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(stderr.trim() || `osgconv failed: ${args.join(" ")}`));
			else resolve();
		});
	});
}

// Per-node osgb filenames. The ENTRY name uses the FULL octant path as the suffix so it is
// unique even when several nodes in one grid tile share a short suffix. The _complete /
// _masked geode files derive from it; they hold the actual mesh, the entry file holds the
// wrapper (internal node) or the geode itself (leaf node).
function osgbFileName(gridTile, pathName) {
	return `${gridTile}_L${pathName.length}_${pathName}.osgb`;
}

function geodeNames(gridTile, pathName) {
	const entry = osgbFileName(gridTile, pathName);
	const base = entry.replace(/\.osgb$/, "");
	return { entry, complete: `${base}_complete.osgb`, masked: `${base}_masked.osgb` };
}

// A node is internal (gets a wrapper) iff it has child octants recorded at staging time.
// Driving both streaming and finalize off the same childMap keeps the two passes in lock
// step: streaming builds _complete/_masked for these nodes (leaving the entry for finalize)
// and a terminal geode entry for the rest.
function isInternalNode(index, pathName) {
	const oct = index.childMap && index.childMap[pathName];
	return Array.isArray(oct) && oct.length > 0;
}

// PagedLOD wrapper referencing external geode + child files. Mirrors the dual-geode ranges
// (complete = FAR [0,T], masked + children = NEAR [T,1e30]) but embeds nothing, so it is
// cheap to write and convert. With no children it degrades to a complete-only node (so a
// node whose children all turned out empty shows its full mesh rather than a holed mask).
function writeWrapperPagedLodOsgt({ outputPath, completeFile, maskedFile = null, childFiles = [], center, rangeThreshold }) {
	const slots = [{ file: completeFile, lo: 0, hi: rangeThreshold }];
	if (childFiles.length > 0) {
		if (maskedFile) slots.push({ file: maskedFile, lo: rangeThreshold, hi: 1e30 });
		for (const f of childFiles) slots.push({ file: f, lo: rangeThreshold, hi: 1e30 });
	} else {
		// No finer children: the complete mesh should cover the whole near range too.
		slots[0].hi = 1e30;
	}
	const n = slots.length;
	const fmtHi = (hi) => (hi >= 1e30 ? "1e+30" : `${hi}`);
	const rangeList = slots.map((s) => `    ${s.lo} ${fmtHi(s.hi)} `).join("\n");
	const rangeData = slots.map((s) => `    "${s.file}" `).join("\n");
	const priority = slots.map(() => "    0 1 ").join("\n");

	const content = `#Ascii Scene
#Version 161
#Generator OpenSceneGraph 3.6.5

osg::PagedLOD {
  UniqueID 1
  CenterMode USER_DEFINED_CENTER
  UserCenter ${center.cx} ${center.cy} ${center.cz} ${center.radius}
  RangeMode PIXEL_SIZE_ON_SCREEN
  RangeList ${n} {
${rangeList}
  }
  DatabasePath FALSE
  RangeDataList ${n} {
${rangeData}
  }
  PriorityList ${n} {
${priority}
  }
}`;
	fs.writeFileSync(outputPath, content);
}

// Convert jobs (one per geode) for a single staged node, ready to feed an osgb convert
// pool. Leaf -> the entry geode. Internal -> _complete (+ _masked when present). Returns
// null when the node was never staged (empty mesh). Pure / synchronous so the caller can
// enqueue every job up front (no await between enqueues => convert-pool drain can't race).
function buildStagedGeodeJobs({ stagingDir, dataDir, gridTile, pathName, isLeaf }) {
	const nodeDir = stagingNodeDir(stagingDir, pathName);
	const fullObj = path.join(nodeDir, "node.obj");
	if (!fs.existsSync(fullObj)) return null;
	// Geode conversion runs with cwd = the staging node dir but writes into Data/, so the
	// output MUST be absolute — a relative path would be resolved against the staging dir
	// (both osgconv's write and the convert pool's existence check go wrong otherwise).
	const tileDir = path.resolve(dataDir, gridTile);
	const names = geodeNames(gridTile, pathName);

	if (isLeaf) {
		return { tileDir, jobs: [{ workDir: nodeDir, inputName: "node.obj", outputPath: path.join(tileDir, names.entry) }] };
	}

	const jobs = [{ workDir: nodeDir, inputName: "node.obj", outputPath: path.join(tileDir, names.complete) }];
	const maskedDir = path.join(nodeDir, "_masked");
	if (fs.existsSync(path.join(maskedDir, "node.obj"))) {
		jobs.push({ workDir: maskedDir, inputName: "node.obj", outputPath: path.join(tileDir, names.masked) });
	}
	return { tileDir, jobs };
}

// Offline geode build for one node (build:densify path), using the standalone osgconv.
async function buildNodeGeodesAsync({ stagingDir, tileDir, gridTile, pathName, isLeaf }) {
	const built = buildStagedGeodeJobs({ stagingDir, dataDir: path.dirname(tileDir), gridTile, pathName, isLeaf });
	if (!built) return false;
	for (const job of built.jobs) {
		await runOsgConvAsync([job.inputName, job.outputPath], job.workDir);
	}
	return true;
}

// Write + convert one internal node's wrapper entry file. childEntryFiles are the entry
// names of this node's children (resolved by nearest exported ancestor). hasMasked is
// checked from disk so we only reference a masked geode that was actually produced.
async function buildNodeWrapperAsync({ tileDir, gridTile, pathName, childEntryFiles, center, rangeThreshold }) {
	const names = geodeNames(gridTile, pathName);
	const completePath = path.join(tileDir, names.complete);
	if (!fs.existsSync(completePath)) return false;
	const hasMasked = fs.existsSync(path.join(tileDir, names.masked));

	const tempOsgt = path.join(tileDir, `_dn_${pathName}.osgt`);
	writeWrapperPagedLodOsgt({
		outputPath: tempOsgt,
		completeFile: names.complete,
		maskedFile: hasMasked ? names.masked : null,
		childFiles: childEntryFiles,
		center,
		rangeThreshold,
	});
	await runOsgConvAsync([path.basename(tempOsgt), names.entry], tileDir);
	fs.removeSync(tempOsgt);
	return true;
}

// Group exported paths by grid tile.
function groupByTile(paths, index) {
	const byTile = new Map();
	for (const p of paths) {
		const t = index.nodes[p]?.gridTile;
		if (!t) continue;
		if (!byTile.has(t)) byTile.set(t, []);
		byTile.get(t).push(p);
	}
	return byTile;
}

// Phase: wrappers for every internal node + the tile-root force-load files. Geodes are
// assumed already on disk (built during streaming, or by buildAllNodeGeodes offline). This
// is the only work the streaming finalize has to do.
async function buildWrappersAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats }) {
	const dataDir = path.join(outputDir, "Data");
	const osgbNameOf = (p) => osgbFileName(index.nodes[p].gridTile, p);

	// Internal-node wrappers (entry files). Each only references file names, so wrappers
	// have no ordering dependency on each other or on geode conversion finishing.
	const wrapperJobs = [];
	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		const tileDir = path.join(dataDir, tileName);
		const inTile = new Set(tilePaths);
		for (const pathName of tilePaths) {
			if (!isInternalNode(index, pathName)) continue;
			const childEntryFiles = (childrenOf[pathName] || []).filter((c) => inTile.has(c)).map(osgbNameOf);
			wrapperJobs.push({
				tileDir,
				gridTile: tileName,
				pathName,
				childEntryFiles,
				center: index.nodes[pathName]?.bounds,
				rangeThreshold: pixelRangeForLevel(pathName.length, maxLevel),
			});
		}
	}
	await pool.map(wrapperJobs, async (job) => {
		try {
			if (!job.center) {
				stats.errors.push({ pathName: job.pathName, error: "missing bounds for wrapper" });
				return;
			}
			if (await buildNodeWrapperAsync(job)) stats.nodes++;
		} catch (error) {
			stats.errors.push({ pathName: job.pathName, error: error.message || String(error) });
		}
	});

	// Tile roots: force-load the region roots (nodes with no exported ancestor inside the
	// tile). References entry file names only.
	const tileNames = [...byTile.keys()].filter((t) => !gridFilter || gridFilter.has(t));
	await pool.map(tileNames, async (tileName) => {
		const tilePaths = byTile.get(tileName);
		const tileDir = path.join(dataDir, tileName);
		const inTile = new Set(tilePaths);
		try {
			await fs.ensureDir(tileDir);
			const regionRoots = tilePaths.filter((p) => !parentOf[p] || !inTile.has(parentOf[p]));
			const rootChildFiles = regionRoots.map(osgbNameOf);
			const center = mergeIndexBounds(tilePaths, index) || index.nodes[tilePaths[0]]?.bounds;
			if (rootChildFiles.length > 0 && center) {
				const tempRoot = path.join(tileDir, "_root.osgt");
				writeTileRootOsgt({ outputPath: tempRoot, childFiles: rootChildFiles, center });
				await runOsgConvAsync([path.basename(tempRoot), `${tileName}.osgb`], tileDir);
				fs.removeSync(tempRoot);
				stats.rootFiles++;
			}
		} catch (error) {
			stats.errors.push({ tileName, error: error.message || String(error) });
		}
		stats.tiles++;
		stats.tileNames.push(tileName);
	});
	stats.tileNames.sort();
}

// Streaming finalize: geodes were already converted incrementally during the export, so we
// only need the cheap wrapper + tile-root pass. Called from the export pipeline.
async function finalizeDensifiedWrappers(outputDir, { index, maxLevel, onlyGridTiles = null, concurrency = getDefaultConcurrency() }) {
	const paths = Object.keys(index.nodes || {});
	const { childrenOf, parentOf } = buildLodTree(paths);
	const gridFilter = onlyGridTiles ? new Set(onlyGridTiles) : null;
	const byTile = groupByTile(paths, index);
	const stats = { tiles: 0, nodes: 0, rootFiles: 0, errors: [], tileNames: [] };
	const pool = createAsyncPool(concurrency);
	await buildWrappersAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats });
	return stats;
}

// Offline full build (build:densify): convert every node's geode(s), then wrappers + roots.
// Produces output byte-identical to what streaming geode build + finalizeDensifiedWrappers
// would produce, so the two entry points stay interchangeable.
async function buildDensifiedPyramidRegion(outputDir, { index, maxLevel, onlyGridTiles = null, concurrency = getDefaultConcurrency() }) {
	const stagingDir = path.join(outputDir, ".staging");
	const dataDir = path.join(outputDir, "Data");
	const paths = Object.keys(index.nodes || {});
	const { childrenOf, parentOf } = buildLodTree(paths);
	const gridFilter = onlyGridTiles ? new Set(onlyGridTiles) : null;
	const byTile = groupByTile(paths, index);

	const stats = { tiles: 0, nodes: 0, rootFiles: 0, errors: [], tileNames: [] };
	const pool = createAsyncPool(concurrency);

	// Phase A — geodes for every node (leaf entry geode, or internal _complete/_masked).
	const geodeJobs = [];
	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		const tileDir = path.join(dataDir, tileName);
		await fs.ensureDir(tileDir);
		for (const pathName of tilePaths) {
			geodeJobs.push({ tileDir, gridTile: tileName, pathName, isLeaf: !isInternalNode(index, pathName) });
		}
	}
	await pool.map(geodeJobs, async ({ tileDir, gridTile, pathName, isLeaf }) => {
		try {
			await buildNodeGeodesAsync({ stagingDir, tileDir, gridTile, pathName, isLeaf });
		} catch (error) {
			stats.errors.push({ pathName, error: error.message || String(error) });
		}
	});

	// Phase B — wrappers + tile roots (mesh-free).
	await buildWrappersAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats });
	return stats;
}

module.exports = {
	osgbFileName,
	geodeNames,
	isInternalNode,
	writeWrapperPagedLodOsgt,
	buildStagedGeodeJobs,
	finalizeDensifiedWrappers,
	buildDensifiedPyramidRegion,
};
