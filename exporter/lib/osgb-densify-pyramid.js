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
const { buildLodTree, pixelRangeForLevel, writeTileRootOsgt, mergeIndexBounds } = require("./osgb-paged-lod");
const { extractTopNode } = require("./osgb-lod-pyramid");
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

// osgb geode -> its osg scene node as osgt text, for inlining into a node's CC file. The
// streaming pass already converted each node's mesh into _complete/_masked osgb; reading
// them back here is far cheaper than re-decoding the OBJ, and lets finalize assemble the
// single inline-geometry file ContextCapture expects without re-doing the heavy mesh work.
async function osgbToGeodeScene(osgbPath) {
	const dir = path.dirname(osgbPath);
	const base = path.basename(osgbPath, ".osgb");
	const tempOsgt = path.join(dir, `_ex_${base}.osgt`);
	await runOsgConvAsync([path.basename(osgbPath), path.basename(tempOsgt)], dir);
	const scene = extractTopNode(fs.readFileSync(tempOsgt, "utf8"));
	fs.removeSync(tempOsgt);
	if (!scene) throw new Error(`Failed to extract scene from ${osgbPath}`);
	return scene;
}

function maxUniqueId(text) {
	let m;
	let mx = 0;
	const re = /\bUniqueID\s+(\d+)/g;
	while ((m = re.exec(text)) !== null) mx = Math.max(mx, parseInt(m[1], 10));
	return mx;
}

// Shift every UniqueID by off so the two embedded geodes + the PagedLOD get disjoint id
// ranges — the geodes come from independent osgconv runs that both start numbering at 1, so
// without this the combined file has duplicate UniqueIDs and osgconv refuses to parse it.
function offsetUniqueIds(text, off) {
	if (!off) return text;
	return text.replace(/\bUniqueID\s+(\d+)/g, (_, n) => `UniqueID ${parseInt(n, 10) + off}`);
}

function indent(text) {
	return text.split("\n").map((l) => `    ${l}`).join("\n");
}

// Progress ticker: logs roughly every 5% (and on the last item) so long build passes show
// movement instead of going silent between the start and the final summary.
function makeTicker(label, total) {
	if (!total) return () => {};
	const step = Math.max(1, Math.floor(total / 20));
	let done = 0;
	return () => {
		done++;
		if (done === total || done % step === 0) {
			console.log(`  ${label}: ${done}/${total} (${Math.round((done / total) * 100)}%)`);
		}
	};
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

// --- LOD bundling (Direction 2: pack several LOD levels into one osgb) ---------------
//
// One file per node makes the densest octree levels emit thousands of tiny PagedLODs, so
// navigating pages a flood of small files in/out ("一直加载"). Instead we group every
// BUNDLE_LEVELS LOD hops into ONE file: inside a file the PagedLOD hierarchy is nested
// inline (LOD still works), and we only page across files at bundle boundaries. That cuts
// file count and paging hops by ~BUNDLE_LEVELS×. Set ERE_LOD_BUNDLE_LEVELS (default 3;
// 1 = old one-file-per-node behaviour).
const BUNDLE_LEVELS = Math.max(1, parseInt(process.env.ERE_LOD_BUNDLE_LEVELS, 10) || 3);

// Render a PagedLOD node-block (no file header) with the geometry inline (complete = FAR,
// masked = NEAR), plus inline nested child blocks and/or external child-file refs (NEAR).
function renderPagedLodBlock({ id, complete, masked, inlineBlocks, externalFiles, center, rangeThreshold }) {
	const inlineChildren = [complete, ...(masked ? [masked] : []), ...inlineBlocks];
	const inlineCount = inlineChildren.length;
	const slots = inlineCount + externalFiles.length;
	const rangeLines = [`    0 ${rangeThreshold} `];
	for (let i = 1; i < slots; i++) rangeLines.push(`    ${rangeThreshold} 1e+30 `);
	const rangeData = inlineChildren.map(() => `    "" `).concat(externalFiles.map((f) => `    "${f}" `));
	const priority = Array.from({ length: slots }, () => "    0 1 ");
	const childrenBlock = inlineChildren.map(indent).join("\n");
	return `osg::PagedLOD {
  UniqueID ${id}
  CenterMode USER_DEFINED_CENTER
  UserCenter ${center.cx} ${center.cy} ${center.cz} ${center.radius}
  RangeMode PIXEL_SIZE_ON_SCREEN
  RangeList ${slots} {
${rangeLines.join("\n")}
  }
  DatabasePath FALSE
  RangeDataList ${slots} {
${rangeData.join("\n")}
  }
  PriorityList ${slots} {
${priority.join("\n")}
  }
  Children ${inlineCount} {
${childrenBlock}
  }
}`;
}

// Pure: shape one bundle rooted at `anchor`. In-tile children that are themselves anchors
// become external refs (the next bundle down); the rest are inlined recursively. Returns a
// tree of { node, inlineChildren[], externalChildren[] }.
function shapeBundle(anchor, { childrenInTile, isAnchor }) {
	const walk = (node) => {
		const inlineChildren = [];
		const externalChildren = [];
		for (const c of childrenInTile(node)) {
			if (isAnchor(c)) externalChildren.push(c);
			else inlineChildren.push(walk(c));
		}
		return { node, inlineChildren, externalChildren };
	};
	return walk(anchor);
}

function bundleNodes(tree, out = []) {
	out.push(tree.node);
	for (const child of tree.inlineChildren) bundleNodes(child, out);
	return out;
}

// Pure: turn a shaped bundle tree + per-node geode scenes into one nested osgt node-block,
// offsetting UniqueIDs so every embedded geode/PagedLOD stays unique within the file.
function assembleBundle(tree, idBase, geodeMap, { gridTileOf, boundsOf, maxLevel }) {
	const node = tree.node;
	const g = geodeMap.get(node);
	const complete = offsetUniqueIds(g.complete, idBase);
	let runId = maxUniqueId(complete);

	if (tree.inlineChildren.length === 0 && tree.externalChildren.length === 0) {
		return { block: complete, maxId: runId }; // leaf geode, no PagedLOD needed
	}

	let masked = null;
	if (g.masked) { masked = offsetUniqueIds(g.masked, runId); runId = maxUniqueId(masked); }

	const inlineBlocks = [];
	for (const childTree of tree.inlineChildren) {
		const cb = assembleBundle(childTree, runId, geodeMap, { gridTileOf, boundsOf, maxLevel });
		runId = cb.maxId;
		inlineBlocks.push(cb.block);
	}
	const externalFiles = tree.externalChildren.map((c) => osgbFileName(gridTileOf(c), c));
	const pagedLodId = runId + 1;
	const block = renderPagedLodBlock({
		id: pagedLodId,
		complete,
		masked,
		inlineBlocks,
		externalFiles,
		center: boundsOf(node),
		rangeThreshold: pixelRangeForLevel(node.length, maxLevel),
	});
	return { block, maxId: pagedLodId };
}

// Read a node's geode scene(s) from the streaming-built osgb (leaf geode = entry file;
// internal = _complete + optional _masked).
async function readNodeGeodes(node, { gridTileOf, tileDirOf, isInternal }) {
	const tile = gridTileOf(node);
	const names = geodeNames(tile, node);
	const dir = tileDirOf(tile);
	const internal = isInternal(node);
	const complete = await osgbToGeodeScene(path.join(dir, internal ? names.complete : names.entry));
	let masked = null;
	const maskedPath = path.join(dir, names.masked);
	if (internal && fs.existsSync(maskedPath)) masked = await osgbToGeodeScene(maskedPath);
	return [node, { complete, masked }];
}

// Build one bundle file: shape the tree, read every member node's geode in parallel,
// assemble the nested osgt, convert to the anchor's entry osgb. Returns nodes packed.
async function buildBundleAsync(anchor, ctx) {
	const tree = shapeBundle(anchor, ctx);
	const nodes = bundleNodes(tree);
	if (nodes.length === 1 && tree.externalChildren.length === 0) {
		return 0; // lone leaf anchor — its streaming entry geode is already the final file
	}
	const geodeMap = new Map(await Promise.all(nodes.map((n) => readNodeGeodes(n, ctx))));
	const top = assembleBundle(tree, 0, geodeMap, ctx);
	const tile = ctx.gridTileOf(anchor);
	const tileDir = ctx.tileDirOf(tile);
	const names = geodeNames(tile, anchor);
	const tempOsgt = path.join(tileDir, `_bundle_${anchor}.osgt`);
	fs.writeFileSync(tempOsgt, `#Ascii Scene\n#Version 161\n#Generator OpenSceneGraph 3.6.5\n\n${top.block}`);
	await runOsgConvAsync([path.basename(tempOsgt), names.entry], tileDir);
	fs.removeSync(tempOsgt);
	return nodes.length;
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

// LOD-tree depth of every node (region root = 0), so we can pick anchors every
// BUNDLE_LEVELS hops. Children resolved by nearest exported ancestor, restricted to the
// same grid tile (a subtree is anchored to one tile, and file refs resolve within a dir).
function computeLodDepths(byTile, childrenOf, parentOf) {
	const depth = new Map();
	for (const [, tilePaths] of byTile.entries()) {
		const inTile = new Set(tilePaths);
		const roots = tilePaths.filter((p) => !parentOf[p] || !inTile.has(parentOf[p]));
		const queue = roots.map((r) => [r, 0]);
		for (const [r] of queue.map((x) => x)) depth.set(r, 0);
		while (queue.length > 0) {
			const [node, d] = queue.shift();
			for (const c of (childrenOf[node] || [])) {
				if (!inTile.has(c) || depth.has(c)) continue;
				depth.set(c, d + 1);
				queue.push([c, d + 1]);
			}
		}
	}
	return depth;
}

// Phase: pack the per-node geodes into bundle files (BUNDLE_LEVELS LOD levels each), build
// tile roots, then delete the now-inlined aux geode files so the final layout is the
// bundled CC pyramid. Geodes are assumed on disk (streaming, or Phase A offline).
async function buildBundlesAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats }) {
	const dataDir = path.join(outputDir, "Data");
	const tileDirOf = (t) => path.join(dataDir, t);
	const tileOfNode = new Map();
	for (const [t, ps] of byTile.entries()) for (const p of ps) tileOfNode.set(p, t);
	const gridTileOf = (p) => tileOfNode.get(p);

	const depth = computeLodDepths(byTile, childrenOf, parentOf);
	const isAnchor = (p) => (depth.get(p) || 0) % BUNDLE_LEVELS === 0;
	const childrenInTile = (p) => (childrenOf[p] || []).filter((c) => tileOfNode.get(c) === tileOfNode.get(p));

	const ctx = {
		childrenInTile,
		isAnchor,
		gridTileOf,
		tileDirOf,
		isInternal: (p) => isInternalNode(index, p),
		boundsOf: (p) => index.nodes[p]?.bounds,
		maxLevel,
	};

	// Anchors (one bundle file each). Region roots are depth 0 => always anchors.
	const anchors = [];
	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		await fs.ensureDir(tileDirOf(tileName));
		for (const p of tilePaths) if (isAnchor(p)) anchors.push(p);
	}

	const bundleTick = makeTicker("bundles", anchors.length);
	await pool.map(anchors, async (anchor) => {
		try {
			const packed = await buildBundleAsync(anchor, ctx);
			if (packed > 0) stats.nodes++;
		} catch (error) {
			stats.errors.push({ pathName: anchor, error: error.message || String(error) });
		}
		bundleTick();
	});

	// Tile roots: force-load the region roots (depth-0 anchors). References entry file names.
	const tileNames = [...byTile.keys()].filter((t) => !gridFilter || gridFilter.has(t));
	const rootTick = makeTicker("tile roots", tileNames.length);
	const osgbNameOf = (p) => osgbFileName(gridTileOf(p), p);
	await pool.map(tileNames, async (tileName) => {
		const tilePaths = byTile.get(tileName);
		const tileDir = tileDirOf(tileName);
		const inTile = new Set(tilePaths);
		try {
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
		rootTick();
	});

	// Cleanup: every node's geode is now inlined into some bundle. Drop all aux geodes, and
	// the entry geodes of non-anchor leaves (anchors keep their entry = the bundle file).
	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		const tileDir = tileDirOf(tileName);
		for (const p of tilePaths) {
			const names = geodeNames(tileName, p);
			fs.removeSync(path.join(tileDir, names.complete));
			fs.removeSync(path.join(tileDir, names.masked));
			if (!isInternalNode(index, p) && !isAnchor(p)) {
				fs.removeSync(path.join(tileDir, names.entry));
			}
		}
	}
	stats.tileNames.sort();
}

// Streaming finalize: geodes were already converted incrementally during the export, so we
// only need the bundle + tile-root pass. Called from the export pipeline.
async function finalizeDensifiedWrappers(outputDir, { index, maxLevel, onlyGridTiles = null, concurrency = getDefaultConcurrency() }) {
	const paths = Object.keys(index.nodes || {});
	const { childrenOf, parentOf } = buildLodTree(paths);
	const gridFilter = onlyGridTiles ? new Set(onlyGridTiles) : null;
	const byTile = groupByTile(paths, index);
	const stats = { tiles: 0, nodes: 0, rootFiles: 0, errors: [], tileNames: [] };
	const pool = createAsyncPool(concurrency);
	await buildBundlesAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats });
	return stats;
}

// Offline full build (build:densify): convert every node's geode(s), then bundle + roots.
// Produces the same output as streaming geode build + finalizeDensifiedWrappers, so the
// two entry points stay interchangeable.
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
	const geodeTick = makeTicker("geodes", geodeJobs.length);
	await pool.map(geodeJobs, async ({ tileDir, gridTile, pathName, isLeaf }) => {
		try {
			await buildNodeGeodesAsync({ stagingDir, tileDir, gridTile, pathName, isLeaf });
		} catch (error) {
			stats.errors.push({ pathName, error: error.message || String(error) });
		}
		geodeTick();
	});

	// Phase B — pack geodes into bundle files (BUNDLE_LEVELS levels each) + tile roots.
	await buildBundlesAndRoots(outputDir, { index, maxLevel, byTile, childrenOf, parentOf, gridFilter, pool, stats });
	return stats;
}

module.exports = {
	osgbFileName,
	geodeNames,
	isInternalNode,
	buildStagedGeodeJobs,
	finalizeDensifiedWrappers,
	buildDensifiedPyramidRegion,
};
