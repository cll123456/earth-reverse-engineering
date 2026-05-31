"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const {
	DEFAULT_LOD_PREFIX_LEVEL,
	buildOsgbFileName,
} = require("./osgb-grid");
const { ensureIndexChildMap } = require("./osgb-index");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./osgb-convert");

const TILE_DATABASE_PATH = "./";

function runOsgConv(args, cwd) {
	const osgConvPath = findOsgConv();
	if (!osgConvPath) {
		throw new Error("osgconv not found. Install OpenSceneGraph and ensure osgconv is on PATH.");
	}
	const result = spawnSync(osgConvPath, [...OSGCONV_INLINE_TEXTURES, ...args], {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `osgconv failed: ${args.join(" ")}`);
	}
}

function objBoundsToOsgbBounds(minX, minY, minZ, maxX, maxY, maxZ) {
	// iFreedo osgconv maps OBJ (x, y, z) -> OSGB (x, -z, y).
	const osgMinX = minX;
	const osgMaxX = maxX;
	const osgMinY = -maxZ;
	const osgMaxY = -minZ;
	const osgMinZ = minY;
	const osgMaxZ = maxY;
	const cx = (osgMinX + osgMaxX) / 2;
	const cy = (osgMinY + osgMaxY) / 2;
	const cz = (osgMinZ + osgMaxZ) / 2;
	const radius = Math.sqrt(
		(osgMaxX - osgMinX) ** 2 + (osgMaxY - osgMinY) ** 2 + (osgMaxZ - osgMinZ) ** 2,
	) / 2;
	return { cx, cy, cz, radius: Math.max(radius, 1) };
}

function readObjBounds(objPath) {
	const text = fs.readFileSync(objPath, "utf8");
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	let count = 0;
	for (const line of text.split("\n")) {
		if (!line.startsWith("v ")) continue;
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		const x = parseFloat(parts[1]);
		const y = parseFloat(parts[2]);
		const z = parseFloat(parts[3]);
		if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		minZ = Math.min(minZ, z);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
		maxZ = Math.max(maxZ, z);
		count++;
	}
	if (count === 0) return null;
	return objBoundsToOsgbBounds(minX, minY, minZ, maxX, maxY, maxZ);
}

function pixelRangeForLevel(level, maxLevel) {
	const delta = Math.max(0, maxLevel - level);
	return Math.max(40, 50 * (2 ** (delta * 0.35)));
}

function extractGeodeScene(osgtText) {
	const geodeIndex = osgtText.indexOf("osg::Geode");
	const start = geodeIndex >= 0 ? geodeIndex : osgtText.search(/^(osg::Group|osg::Geode|osg::PagedLOD)\s*\{/m);
	if (start < 0) return null;
	const lines = osgtText.slice(start).split("\n");
	let depth = 0;
	let end = 0;
	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === "{") depth++;
			if (ch === "}") depth--;
		}
		if (depth === 0) {
			end = i;
			break;
		}
	}
	return lines.slice(0, end + 1).join("\n");
}

function convertOsgbToGeodeScene(osgbPath) {
	const dir = path.dirname(osgbPath);
	const tempOsgt = path.join(dir, `_geode_${path.basename(osgbPath, ".osgb")}.osgt`);
	runOsgConv([path.basename(osgbPath), path.basename(tempOsgt)], dir);
	const scene = extractGeodeScene(fs.readFileSync(tempOsgt, "utf8"));
	fs.removeSync(tempOsgt);
	if (!scene) {
		throw new Error(`Failed to extract Geode from ${osgbPath}`);
	}
	return scene;
}

// Wrap a single octree node as a PagedLOD: its own geometry (geodeScene) is shown
// when the node projects small on screen ([0, rangeThreshold] px), and ALL of its
// exported octree children are paged in to replace it once it grows past the
// threshold ([rangeThreshold, 1e30]). Referencing every child (not just one) is
// what makes the 8-way octree actually expand; the children sit in the same tile
// folder, so each is a plain same-directory filename.
function writePagedLodOsgt({
	outputPath,
	databasePath = TILE_DATABASE_PATH,
	childFiles,
	geodeScene = null,
	center,
	rangeThreshold,
}) {
	const dbPath = databasePath.replace(/\\/g, "/");
	if (!dbPath.endsWith("/")) {
		throw new Error(`databasePath must end with /: ${databasePath}`);
	}
	const files = Array.isArray(childFiles) ? childFiles : (childFiles ? [childFiles] : []);
	if (files.length === 0) {
		throw new Error("writePagedLodOsgt requires at least one child file");
	}
	const childBlock = geodeScene
		? `  Children 1 {
${geodeScene.split("\n").map((line) => `    ${line}`).join("\n")}
  }
`
		: "";
	// Slot 0 is the inline geode (this node's own mesh); slots 1..k page in children.
	const slots = 1 + files.length;
	const rangeList = [
		`    0 ${rangeThreshold} `,
		...files.map(() => `    ${rangeThreshold} 1e+30 `),
	].join("\n");
	const rangeData = [
		`    "" `,
		...files.map((f) => `    "${f}" `),
	].join("\n");
	const priorityList = Array.from({ length: slots }, () => "    0 1 ").join("\n");
	const content = `#Ascii Scene
#Version 161
#Generator OpenSceneGraph 3.6.5

osg::PagedLOD {
  UniqueID 1
  CenterMode USER_DEFINED_CENTER
  UserCenter ${center.cx} ${center.cy} ${center.cz} ${center.radius}
  RangeMode PIXEL_SIZE_ON_SCREEN
  RangeList ${slots} {
${rangeList}
  }
  DatabasePath TRUE "${dbPath}"
  RangeDataList ${slots} {
${rangeData}
  }
  PriorityList ${slots} {
${priorityList}
  }
${childBlock}}`;
	fs.writeFileSync(outputPath, content);
}

// Every exported octree child of a node — the full set, not just the first. The
// node's wrapped PagedLOD must reference all of them, otherwise only one of up to
// eight branches ever refines.
function pickExportedChildren(pathName, childMap, exportedSet) {
	const children = childMap[pathName] || [];
	const exported = [];
	for (const oct of children) {
		const childPath = `${pathName}${oct}`;
		if (exportedSet.has(childPath)) exported.push(childPath);
	}
	return exported;
}

// Build the LOD tree by NEAREST exported ancestor, not strict parent (path length
// -1). Google Earth's octree is sparse: many levels have no node, so an L18 leaf's
// immediate L17 parent often was never exported while its L16 ancestor was. Linking
// by immediate parent would orphan those leaves (they'd look like region roots and
// the tile root would flat-load them — the original crash). Each node instead
// attaches to the longest exported path that is a strict prefix of it.
function buildLodTree(exportedPaths) {
	const set = new Set(exportedPaths);
	const parentOf = {};
	const childrenOf = {};
	for (const pathName of exportedPaths) childrenOf[pathName] = [];
	for (const pathName of exportedPaths) {
		let parent = null;
		for (let len = pathName.length - 1; len >= 1; len--) {
			const ancestor = pathName.substring(0, len);
			if (set.has(ancestor)) {
				parent = ancestor;
				break;
			}
		}
		parentOf[pathName] = parent;
		if (parent) childrenOf[parent].push(pathName);
	}
	for (const list of Object.values(childrenOf)) list.sort();
	return { parentOf, childrenOf };
}

function pickRootPathName(pathNames, lodPrefixLevel) {
	const rootCandidates = pathNames
		.filter((pathName) => pathName.length === lodPrefixLevel + 1)
		.sort();
	return rootCandidates[0] || pathNames.slice().sort((a, b) => a.length - b.length)[0] || null;
}

function pickFinestExportedDescendant(pathName, exportedSet) {
	let finest = exportedSet.has(pathName) ? pathName : null;
	for (const candidate of exportedSet) {
		if (!candidate.startsWith(pathName) || candidate.length <= pathName.length) continue;
		if (!finest || candidate.length > finest.length) finest = candidate;
	}
	return finest;
}

// index.nodes[].bounds are already in OSGB space (readObjBounds applied the
// OBJ->OSGB axis swap at export time). Merge those AABBs directly; re-applying
// objBoundsToOsgbBounds here would swap north<->up a second time and place the
// parent bounding sphere far from its children, so DasViewer culls everything.
function mergeIndexBounds(pathNames, index) {
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	let count = 0;
	for (const pathName of pathNames) {
		const bounds = index.nodes[pathName]?.bounds;
		if (!bounds) continue;
		minX = Math.min(minX, bounds.cx - bounds.radius);
		minY = Math.min(minY, bounds.cy - bounds.radius);
		minZ = Math.min(minZ, bounds.cz - bounds.radius);
		maxX = Math.max(maxX, bounds.cx + bounds.radius);
		maxY = Math.max(maxY, bounds.cy + bounds.radius);
		maxZ = Math.max(maxZ, bounds.cz + bounds.radius);
		count++;
	}
	if (count === 0) return null;
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const cz = (minZ + maxZ) / 2;
	const radius = Math.sqrt(
		(maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2,
	) / 2;
	return { cx, cy, cz, radius: Math.max(radius, 1) };
}

function pickRootChildForTile(pathNames, gridTileName, exportedSet, lodPrefixLevel) {
	let finest = null;
	for (const pathName of pathNames) {
		if (!exportedSet.has(pathName)) continue;
		if (!finest || pathName.length > finest.length) finest = pathName;
	}
	if (!finest) return null;
	return buildOsgbFileName(gridTileName, finest, lodPrefixLevel);
}

// The tile root must page in the COARSEST nodes of the subtree — the region roots,
// i.e. exported nodes whose own octree parent was not exported (typically the L16
// anchors). Each region root is itself a PagedLOD that lazily refines, so the tile
// shows a light coarse mesh when far and only expands detail on approach. (The old
// behaviour referenced every finest leaf here, forcing the whole subtree resident
// at once — the cause of the DasViewer crash.)
function pickRegionRootFilesForTile(pathNames, index, exportedSet) {
	const files = [];
	for (const pathName of pathNames) {
		if (!exportedSet.has(pathName)) continue;
		const entry = index.nodes[pathName];
		if (!entry || !entry.osgbFile) continue;
		// Region root = no exported ancestor at ANY shorter length (sparse octree).
		let hasAncestor = false;
		for (let len = pathName.length - 1; len >= 1; len--) {
			if (exportedSet.has(pathName.substring(0, len))) {
				hasAncestor = true;
				break;
			}
		}
		if (hasAncestor) continue;
		files.push(entry.osgbFile);
	}
	return files;
}

// Bounding sphere of a node together with its whole exported subtree, computed
// bottom-up. A node's PagedLOD switch and view-frustum cull both use this sphere,
// so it must enclose every descendant that can page in under it — otherwise
// DasViewer culls a parent whose children would still be on screen.
function computeSubtreeBounds(exportedPaths, index, childrenOf) {
	const toAabb = (b) => ({
		minX: b.cx - b.radius,
		minY: b.cy - b.radius,
		minZ: b.cz - b.radius,
		maxX: b.cx + b.radius,
		maxY: b.cy + b.radius,
		maxZ: b.cz + b.radius,
	});
	const union = (a, b) => ({
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		minZ: Math.min(a.minZ, b.minZ),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
		maxZ: Math.max(a.maxZ, b.maxZ),
	});
	// Deepest paths first so a parent sees its children's accumulated boxes.
	const sorted = exportedPaths.slice().sort((a, b) => b.length - a.length || a.localeCompare(b));
	const boxes = {};
	for (const pathName of sorted) {
		const self = index.nodes[pathName]?.bounds;
		let box = self ? toAabb(self) : null;
		for (const childPath of childrenOf[pathName] || []) {
			const childBox = boxes[childPath];
			if (!childBox) continue;
			box = box ? union(box, childBox) : { ...childBox };
		}
		if (box) boxes[pathName] = box;
	}
	const centers = {};
	for (const [pathName, box] of Object.entries(boxes)) {
		const cx = (box.minX + box.maxX) / 2;
		const cy = (box.minY + box.maxY) / 2;
		const cz = (box.minZ + box.maxZ) / 2;
		const radius = Math.sqrt(
			(box.maxX - box.minX) ** 2 + (box.maxY - box.minY) ** 2 + (box.maxZ - box.minZ) ** 2,
		) / 2;
		centers[pathName] = { cx, cy, cz, radius: Math.max(radius, 1) };
	}
	return centers;
}

// Tile root that pages in the region-root nodes. DISTANCE_FROM_EYE_POINT with
// [0, 1e30] keeps each root active at any distance, but each root is a coarse
// PagedLOD that refines on its own, so this only force-loads light geometry.
function writeTileRootOsgt({
	outputPath,
	databasePath = TILE_DATABASE_PATH,
	childFiles,
	center,
}) {
	const dbPath = databasePath.replace(/\\/g, "/");
	if (!dbPath.endsWith("/")) {
		throw new Error(`databasePath must end with /: ${databasePath}`);
	}
	if (!childFiles || childFiles.length === 0) {
		throw new Error("writeTileRootOsgt requires at least one child file");
	}
	const n = childFiles.length;
	const rangeList = childFiles.map(() => "    0 1e+30 ").join("\n");
	const rangeData = childFiles.map((f) => `    "${f}" `).join("\n");
	const priorityList = childFiles.map(() => "    0 1 ").join("\n");
	const content = `#Ascii Scene 
#Version 161 
#Generator OpenSceneGraph 3.6.5 

osg::PagedLOD {
  UniqueID 1 
  CenterMode USER_DEFINED_CENTER 
  UserCenter ${center.cx} ${center.cy} ${center.cz} ${center.radius} 
  RangeMode DISTANCE_FROM_EYE_POINT 
  RangeList ${n} {
${rangeList}
  }
  DatabasePath TRUE "${dbPath}" 
  RangeDataList ${n} {
${rangeData}
  }
  PriorityList ${n} {
${priorityList}
  }
}`;
	fs.writeFileSync(outputPath, content);
}

async function finalizePagedLodRegion(outputDir, {
	index,
	maxLevel,
	lodPrefixLevel = DEFAULT_LOD_PREFIX_LEVEL,
	incremental = false,
	rootsOnly = false,
	saveIndex = true,
}) {
	ensureIndexChildMap(index);
	const dataDir = path.join(outputDir, "Data");
	const exportedPaths = Object.keys(index.nodes || {}).sort();
	const exportedSet = new Set(exportedPaths);

	const stats = {
		gridTiles: 0,
		wrappedFiles: 0,
		rootFiles: 0,
		skipped: 0,
		errors: [],
		gridTileNames: [],
	};

	const { childrenOf } = buildLodTree(exportedPaths);
	const subtreeCenters = computeSubtreeBounds(exportedPaths, index, childrenOf);

	const byGrid = new Map();
	for (const pathName of exportedPaths) {
		const entry = index.nodes[pathName];
		if (!entry) continue;
		if (!byGrid.has(entry.gridTile)) byGrid.set(entry.gridTile, []);
		byGrid.get(entry.gridTile).push(pathName);
	}

	for (const [gridTileName, pathNames] of byGrid.entries()) {
		const tileDir = path.join(dataDir, gridTileName);
		if (!await fs.pathExists(tileDir)) continue;
		stats.gridTiles++;
		stats.gridTileNames.push(gridTileName);

		if (!rootsOnly) {
			for (const pathName of pathNames) {
				const children = childrenOf[pathName] || [];
				if (children.length === 0) continue; // leaf: stays a flat geode

				const entry = index.nodes[pathName];
				if (incremental && entry.flat === false) continue;

				const osgbPath = path.join(tileDir, entry.osgbFile);
				if (!await fs.pathExists(osgbPath)) {
					stats.skipped++;
					continue;
				}

				try {
					// Anchor tiling guarantees children share this tile folder, so each
					// reference is the child's own (same-directory) file name.
					const childFiles = [];
					for (const childPath of children) {
						const childEntry = index.nodes[childPath];
						if (childEntry.gridTile !== gridTileName) {
							throw new Error(
								`child ${childPath} in tile ${childEntry.gridTile}, expected ${gridTileName}`,
							);
						}
						childFiles.push(childEntry.osgbFile);
					}
					const geodeScene = convertOsgbToGeodeScene(osgbPath);
					const tempOsgt = path.join(tileDir, `_wrap_${pathName}.osgt`);
					writePagedLodOsgt({
						outputPath: tempOsgt,
						childFiles,
						geodeScene,
						center: subtreeCenters[pathName] || entry.bounds,
						rangeThreshold: pixelRangeForLevel(pathName.length, maxLevel),
					});
					runOsgConv([path.basename(tempOsgt), entry.osgbFile], tileDir);
					fs.removeSync(tempOsgt);
					entry.flat = false;
					stats.wrappedFiles++;
				} catch (error) {
					stats.errors.push({ pathName, error: error.message || String(error) });
				}
			}
		}

		const rootOsgbPath = path.join(tileDir, `${gridTileName}.osgb`);
		try {
			const childFiles = pickRegionRootFilesForTile(pathNames, index, exportedSet);
			if (childFiles.length === 0) continue;
			const center = mergeIndexBounds(pathNames, index)
				|| index.nodes[pathNames[0]]?.bounds;
			if (!center) continue;
			const tempOsgt = path.join(tileDir, "_root.osgt");
			writeTileRootOsgt({
				outputPath: tempOsgt,
				childFiles,
				center,
			});
			runOsgConv([path.basename(tempOsgt), path.basename(rootOsgbPath)], tileDir);
			fs.removeSync(tempOsgt);
			stats.rootFiles++;
		} catch (error) {
			stats.errors.push({ gridTileName, error: error.message || String(error) });
		}
	}

	if (saveIndex) {
		await fs.ensureDir(outputDir);
		await fs.writeJson(path.join(outputDir, ".region-osgb-index.json"), index, { spaces: 2 });
	}

	stats.gridTileNames.sort();
	return stats;
}

module.exports = {
	TILE_DATABASE_PATH,
	objBoundsToOsgbBounds,
	readObjBounds,
	pixelRangeForLevel,
	pickExportedChildren,
	buildLodTree,
	pickRootPathName,
	pickRootChildForTile,
	pickRegionRootFilesForTile,
	computeSubtreeBounds,
	writePagedLodOsgt,
	writeTileRootOsgt,
	mergeIndexBounds,
	pickFinestExportedDescendant,
	finalizePagedLodRegion,
};
