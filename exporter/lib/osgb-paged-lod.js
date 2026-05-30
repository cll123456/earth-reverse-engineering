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

function writePagedLodOsgt({
	outputPath,
	databasePath = TILE_DATABASE_PATH,
	childFile,
	geodeScene = null,
	center,
	rangeThreshold,
}) {
	const dbPath = databasePath.replace(/\\/g, "/");
	if (!dbPath.endsWith("/")) {
		throw new Error(`databasePath must end with /: ${databasePath}`);
	}
	const childBlock = geodeScene
		? `  Children 1 {
${geodeScene.split("\n").map((line) => `    ${line}`).join("\n")}
  }
`
		: "";
	const content = `#Ascii Scene 
#Version 161 
#Generator OpenSceneGraph 3.6.5 

osg::PagedLOD {
  UniqueID 1 
  CenterMode USER_DEFINED_CENTER 
  UserCenter ${center.cx} ${center.cy} ${center.cz} ${center.radius} 
  RangeMode PIXEL_SIZE_ON_SCREEN 
  RangeList 2 {
    0 ${rangeThreshold} 
    ${rangeThreshold} 1e+30 
  }
  DatabasePath TRUE "${dbPath}" 
  RangeDataList 2 {
    "" 
    "${childFile}" 
  }
  PriorityList 2 {
    0 1 
    0 1 
  }
${childBlock}}`;
	fs.writeFileSync(outputPath, content);
}

function pickPrimaryChild(pathName, childMap, exportedSet) {
	const children = childMap[pathName] || [];
	for (const oct of children) {
		const childPath = `${pathName}${oct}`;
		if (exportedSet.has(childPath)) return childPath;
	}
	return null;
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

// A grid tile cuts across the Google Earth octree, so it holds many sibling
// leaf nodes (nodes with no exported children) at roughly the same level. The
// tile root must reference ALL of them, otherwise the tile shows only one node.
function pickLeafChildFilesForTile(pathNames, index, exportedSet, childMap) {
	const files = [];
	for (const pathName of pathNames) {
		if (!exportedSet.has(pathName)) continue;
		const entry = index.nodes[pathName];
		if (!entry || !entry.osgbFile) continue;
		const exportedKids = (childMap[pathName] || [])
			.map((oct) => `${pathName}${oct}`)
			.filter((child) => exportedSet.has(child));
		if (exportedKids.length > 0) continue;
		files.push(entry.osgbFile);
	}
	return files;
}

// Tile root that pages in every leaf simultaneously. DISTANCE_FROM_EYE_POINT with
// [0, 1e30] keeps each child active at any distance, so OSG renders all of them;
// per-leaf culling still happens via each loaded child's own bounding sphere.
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
	const childMap = index.childMap || {};

	const stats = {
		gridTiles: 0,
		wrappedFiles: 0,
		rootFiles: 0,
		skipped: 0,
		errors: [],
		gridTileNames: [],
	};

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
				const childPath = pickPrimaryChild(pathName, childMap, exportedSet);
				if (!childPath) continue;

				const entry = index.nodes[pathName];
				if (incremental && entry.flat === false) continue;

				const osgbPath = path.join(tileDir, entry.osgbFile);
				if (!await fs.pathExists(osgbPath)) {
					stats.skipped++;
					continue;
				}

				try {
					const childFile = buildOsgbFileName(gridTileName, childPath, lodPrefixLevel);
					const geodeScene = convertOsgbToGeodeScene(osgbPath);
					const tempOsgt = path.join(tileDir, `_wrap_${pathName}.osgt`);
					writePagedLodOsgt({
						outputPath: tempOsgt,
						childFile,
						geodeScene,
						center: entry.bounds,
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

		const rootPathName = pickRootPathName(pathNames, lodPrefixLevel);
		const rootEntry = rootPathName ? index.nodes[rootPathName] : null;
		if (!rootEntry) continue;

		const rootOsgbPath = path.join(tileDir, `${gridTileName}.osgb`);
		try {
			const childFiles = pickLeafChildFilesForTile(pathNames, index, exportedSet, childMap);
			if (childFiles.length === 0) continue;
			const center = mergeIndexBounds(pathNames, index) || rootEntry.bounds;
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
	pickPrimaryChild,
	pickRootPathName,
	pickRootChildForTile,
	pickLeafChildFilesForTile,
	writeTileRootOsgt,
	mergeIndexBounds,
	pickFinestExportedDescendant,
	finalizePagedLodRegion,
};
