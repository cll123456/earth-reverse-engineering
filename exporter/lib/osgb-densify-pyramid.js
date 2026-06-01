"use strict";

// Model 3 — densified octree, per-node DUAL-GEODE PagedLODs (no merging, no holes,
// bounded mesh sizes). Each internal octree node N becomes:
//
//   PagedLOD (UserCenter = N's own sphere, PIXEL_SIZE_ON_SCREEN, DatabasePath FALSE) {
//     geode_complete   [0, T]     -> FAR: N's full mesh (all octants) — complete, no hole
//     geode_masked     [T, 1e30]  -> NEAR: N's mesh minus child octants — stays under children
//     child files...   [T, 1e30]  -> NEAR: the real finer children for subdividing octants
//   }
//
// FAR shows only the complete mesh (covers N fully). NEAR swaps it for (masked + real
// children), which tile N exactly: masked = the octants with no finer child, children =
// the octants that do subdivide. No octant ever disappears => no gray holes, and every
// mesh is a single octree node's worth of geometry => no million-face monoliths.
// Requires staged full.obj + _masked/node.obj (see prepareNodeStaging).

const fs = require("fs-extra");
const path = require("path");
const { buildLodTree, readObjBounds, pixelRangeForLevel, writeTileRootOsgt, mergeIndexBounds } = require("./osgb-paged-lod");
const { runOsgConv, objToGeodeScene } = require("./osgb-lod-pyramid");
const { stagingNodeDir } = require("./osgb-staging-writer");

// Per-node osgb filename. Uses the FULL octant path as the suffix so it is unique
// even when several nodes in one grid tile share a short suffix — buildOsgbFileName's
// substring(lodPrefixLevel) collides whenever a tile spans more than one level-15
// octant (different node, same file => overwrite => broken LOD links / lost geodes).
function osgbFileName(gridTile, pathName) {
	return `${gridTile}_L${pathName.length}_${pathName}.osgb`;
}

function maxUniqueId(text) {
	let m;
	let mx = 0;
	const re = /\bUniqueID\s+(\d+)/g;
	while ((m = re.exec(text)) !== null) mx = Math.max(mx, parseInt(m[1], 10));
	return mx;
}

// Shift every UniqueID by off (consistently, so internal object-sharing refs stay
// valid). Used to give the two embedded geodes + the PagedLOD disjoint id ranges —
// duplicate UniqueIDs make osgconv fail to parse the file.
function offsetUniqueIds(text, off) {
	if (!off) return text;
	return text.replace(/\bUniqueID\s+(\d+)/g, (_, n) => `UniqueID ${parseInt(n, 10) + off}`);
}

function indent(text) {
	return text.split("\n").map((l) => `    ${l}`).join("\n");
}

function writeDualGeodePagedLodOsgt({ outputPath, geodeComplete, geodeMasked = null, childFiles = [], center, rangeThreshold }) {
	const completeMax = maxUniqueId(geodeComplete);
	let masked = null;
	let topId = completeMax;
	if (geodeMasked) {
		masked = offsetUniqueIds(geodeMasked, completeMax);
		topId = maxUniqueId(masked);
	}
	const pagedLodId = topId + 1;

	const inlineGeodes = masked ? [geodeComplete, masked] : [geodeComplete];
	const inlineCount = inlineGeodes.length;
	const slots = inlineCount + childFiles.length;

	const rangeLines = [`    0 ${rangeThreshold} `]; // slot 0: complete, shown when FAR
	if (masked) rangeLines.push(`    ${rangeThreshold} 1e+30 `); // slot 1: masked, shown when NEAR
	for (let i = 0; i < childFiles.length; i++) rangeLines.push(`    ${rangeThreshold} 1e+30 `);

	const rangeData = inlineGeodes.map(() => `    "" `).concat(childFiles.map((f) => `    "${f}" `));
	const priority = Array.from({ length: slots }, () => "    0 1 ");
	const childrenBlock = inlineGeodes.map(indent).join("\n");

	const content = `#Ascii Scene
#Version 161
#Generator OpenSceneGraph 3.6.5

osg::PagedLOD {
  UniqueID ${pagedLodId}
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
	fs.writeFileSync(outputPath, content);
}

function buildNode({ tileDir, stagingDir, pathName, osgbName, childOsgbFiles, maxLevel }) {
	const nodeDir = stagingNodeDir(stagingDir, pathName);
	const fullObj = path.join(nodeDir, "node.obj");
	if (!fs.existsSync(fullObj)) return false;

	if (childOsgbFiles.length === 0) {
		// Leaf: terminal geode (osgconv reads textures from the staging dir).
		runOsgConv(["node.obj", path.join(tileDir, osgbName)], nodeDir);
		return true;
	}

	const bounds = readObjBounds(fullObj);
	const geodeComplete = objToGeodeScene(fullObj);
	const maskedObj = path.join(nodeDir, "_masked", "node.obj");
	const geodeMasked = fs.existsSync(maskedObj) ? objToGeodeScene(maskedObj) : null;

	const tempOsgt = path.join(tileDir, `_dn_${pathName}.osgt`);
	writeDualGeodePagedLodOsgt({
		outputPath: tempOsgt,
		geodeComplete,
		geodeMasked,
		childFiles: childOsgbFiles,
		center: bounds,
		rangeThreshold: pixelRangeForLevel(pathName.length, maxLevel),
	});
	runOsgConv([path.basename(tempOsgt), osgbName], tileDir);
	fs.removeSync(tempOsgt);
	return true;
}

async function buildDensifiedPyramidRegion(outputDir, { index, maxLevel, onlyGridTiles = null }) {
	const stagingDir = path.join(outputDir, ".staging");
	const dataDir = path.join(outputDir, "Data");
	const paths = Object.keys(index.nodes || {});
	const { childrenOf, parentOf } = buildLodTree(paths);
	const gridFilter = onlyGridTiles ? new Set(onlyGridTiles) : null;

	const byTile = new Map();
	for (const p of paths) {
		const t = index.nodes[p]?.gridTile;
		if (!t) continue;
		if (!byTile.has(t)) byTile.set(t, []);
		byTile.get(t).push(p);
	}

	const stats = { tiles: 0, nodes: 0, rootFiles: 0, errors: [], tileNames: [] };
	const osgbNameOf = (p) => osgbFileName(index.nodes[p].gridTile, p);

	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		const tileDir = path.join(dataDir, tileName);
		await fs.ensureDir(tileDir);
		const inTile = new Set(tilePaths);

		for (const pathName of tilePaths) {
			const children = (childrenOf[pathName] || []).filter((c) => inTile.has(c));
			const childOsgbFiles = children.map(osgbNameOf);
			try {
				if (buildNode({ tileDir, stagingDir, pathName, osgbName: osgbNameOf(pathName), childOsgbFiles, maxLevel })) {
					stats.nodes++;
				}
			} catch (error) {
				stats.errors.push({ pathName, error: error.message || String(error) });
			}
		}

		// Tile root: force-load the region roots (round-0 nodes — no exported ancestor
		// inside this tile). Each is a complete-far-geode PagedLOD that self-refines.
		try {
			const regionRoots = tilePaths.filter((p) => !parentOf[p] || !inTile.has(parentOf[p]));
			const rootChildFiles = regionRoots.map(osgbNameOf);
			const center = mergeIndexBounds(tilePaths, index) || index.nodes[tilePaths[0]]?.bounds;
			if (rootChildFiles.length > 0 && center) {
				const tempRoot = path.join(tileDir, "_root.osgt");
				writeTileRootOsgt({ outputPath: tempRoot, childFiles: rootChildFiles, center });
				runOsgConv([path.basename(tempRoot), `${tileName}.osgb`], tileDir);
				fs.removeSync(tempRoot);
				stats.rootFiles++;
			}
		} catch (error) {
			stats.errors.push({ tileName, error: error.message || String(error) });
		}

		stats.tiles++;
		stats.tileNames.push(tileName);
	}
	stats.tileNames.sort();
	return stats;
}

module.exports = {
	maxUniqueId,
	offsetUniqueIds,
	writeDualGeodePagedLodOsgt,
	buildDensifiedPyramidRegion,
};
