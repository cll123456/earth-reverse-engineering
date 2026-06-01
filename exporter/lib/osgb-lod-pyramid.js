"use strict";

// Model C — per-tile LOD pyramid of COMPLETE meshes (ContextCapture / Smart3D style,
// the layout DasViewer is proven to consume). Instead of one PagedLOD per octree node
// (which, with baked octant masking, leaves holes when a parent is replaced by a
// sparse set of children), we merge the octree into a small linear chain per tile:
//
//   Tile_X.osgb (round 0, coarsest, complete) --child--> Tile_X_R1.osgb (complete)
//      --child--> ... --child--> Tile_X_R{k}.osgb (finest, all leaves, complete)
//
// Each "round" mesh is a COMPLETE cover of the tile at that frontier:
//   cut(r) = { nodes at tree-depth r } ∪ { leaf nodes at tree-depth < r }
// so refining (round r -> r+1) replaces one complete mesh with a finer complete mesh.
// No node is ever hidden to reveal a gap => no holes. Requires UNMASKED node meshes
// (each staged node exported with exclude=[]), merged here.

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseObj, mergeParsedObjs, buildObjText } = require("./obj-merge");
const { buildLodTree, writePagedLodOsgt, readObjBounds, pixelRangeForLevel } = require("./osgb-paged-lod");
const { stagingNodeDir } = require("./osgb-staging-writer");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./osgb-convert");

function runOsgConv(args, cwd) {
	const osgConvPath = findOsgConv();
	if (!osgConvPath) {
		throw new Error("osgconv not found. Install OpenSceneGraph and ensure osgconv is on PATH.");
	}
	const result = spawnSync(osgConvPath, [...OSGCONV_INLINE_TEXTURES, ...args], {
		cwd,
		stdio: "pipe",
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `osgconv failed: ${args.join(" ")}`);
	}
}

// Extract the first top-level osg:: scene node (balanced braces) from an .osgt — the
// geometry produced by converting a merged .obj. Embedded as the inline child of the
// wrapping PagedLOD.
function extractTopNode(osgtText) {
	const start = osgtText.search(/^osg::\w+\s*\{/m);
	if (start < 0) return null;
	const lines = osgtText.slice(start).split("\n");
	let depth = 0;
	let end = -1;
	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
		if (depth === 0) { end = i; break; }
	}
	if (end < 0) return null;
	return lines.slice(0, end + 1).join("\n");
}

function objToGeodeScene(objPath) {
	const dir = path.dirname(objPath);
	const base = path.basename(objPath, ".obj");
	const tempOsgt = path.join(dir, `_geo_${base}.osgt`);
	runOsgConv([path.basename(objPath), path.basename(tempOsgt)], dir);
	const scene = extractTopNode(fs.readFileSync(tempOsgt, "utf8"));
	fs.removeSync(tempOsgt);
	if (!scene) throw new Error(`Failed to extract scene from ${objPath}`);
	return scene;
}

// Parse a node's staged node.mtl into { material -> textureFileName }.
function readMtlTextures(mtlText) {
	const textures = {};
	let current = null;
	for (const line of mtlText.split("\n")) {
		if (line.startsWith("newmtl ")) current = line.slice(7).trim();
		else if (line.startsWith("map_Kd ") && current) textures[current] = path.basename(line.slice(7).trim());
	}
	return textures;
}

// Rename a parsed node's materials/faces with a unique per-node prefix so that
// identical names across nodes (every node uses "tex_0", ...) do not collide when
// merged. Returns the texture sources to copy into the tile dir.
function namespaceParsed(parsed, nodeMtlTextures, nodeDir, prefix) {
	const rename = (m) => `${prefix}_${m}`;
	const textureSources = {}; // newMaterial -> { source, ext }
	parsed.materials = parsed.materials.map((m) => {
		const nm = rename(m);
		const tex = nodeMtlTextures[m];
		if (tex) {
			textureSources[nm] = {
				source: path.join(nodeDir, tex),
				ext: path.extname(tex),
			};
		}
		return nm;
	});
	for (const face of parsed.faces) {
		if (face.material) face.material = rename(face.material);
	}
	return textureSources;
}

// Merge the staged OBJs of a set of node paths into one complete mesh in tileDir,
// named outputBase(.obj/.mtl + copied textures). Returns objPath or null if empty.
function mergeNodesToObj(stagingDir, tileDir, outputBase, nodePaths) {
	const parsedList = [];
	const textureByMaterial = {};
	let nodeIdx = 0;
	for (const pathName of nodePaths) {
		const nodeDir = stagingNodeDir(stagingDir, pathName);
		const objPath = path.join(nodeDir, "node.obj");
		if (!fs.existsSync(objPath)) continue;
		const objText = fs.readFileSync(objPath, "utf8");
		if (!/\nv /.test(objText)) continue;
		const parsed = parseObj(objText);
		const mtlPath = path.join(nodeDir, "node.mtl");
		const mtlTextures = fs.existsSync(mtlPath) ? readMtlTextures(fs.readFileSync(mtlPath, "utf8")) : {};
		const prefix = `n${nodeIdx++}`;
		const sources = namespaceParsed(parsed, mtlTextures, nodeDir, prefix);
		Object.assign(textureByMaterial, sources);
		parsedList.push(parsed);
	}
	if (parsedList.length === 0) return null;

	const merged = mergeParsedObjs(parsedList);
	fs.ensureDirSync(tileDir);
	const objPath = path.join(tileDir, `${outputBase}.obj`);
	const mtlPath = path.join(tileDir, `${outputBase}.mtl`);
	fs.writeFileSync(objPath, buildObjText(merged, outputBase));

	const mtlLines = [];
	for (const material of merged.materials) {
		const info = textureByMaterial[material];
		let mapLine = "";
		if (info && fs.existsSync(info.source)) {
			const texName = `${outputBase}_${material}${info.ext}`;
			fs.copyFileSync(info.source, path.join(tileDir, texName));
			mapLine = `map_Kd ${texName}`;
		}
		mtlLines.push(
			`newmtl ${material}`,
			"Ka 1.000 1.000 1.000",
			"Kd 1.000 1.000 1.000",
			"Ks 0.000 0.000 0.000",
			"d 1.0",
			"illum 2",
			mapLine,
			"",
		);
	}
	fs.writeFileSync(mtlPath, mtlLines.join("\n"));
	return objPath;
}

// Group exported node paths by their grid tile.
function groupByTile(index) {
	const byTile = new Map();
	for (const [pathName, entry] of Object.entries(index.nodes || {})) {
		if (!entry || !entry.gridTile) continue;
		if (!byTile.has(entry.gridTile)) byTile.set(entry.gridTile, []);
		byTile.get(entry.gridTile).push(pathName);
	}
	return byTile;
}

// Tree depth (round) of every path within a tile's exported subtree. Region roots
// (no exported ancestor inside the tile set) are round 0.
function computeRounds(tilePaths, childrenOf, parentOf) {
	const inTile = new Set(tilePaths);
	const round = {};
	const roots = tilePaths.filter((p) => !parentOf[p] || !inTile.has(parentOf[p]));
	const queue = roots.map((p) => [p, 0]);
	while (queue.length) {
		const [p, r] = queue.shift();
		round[p] = r;
		for (const c of childrenOf[p] || []) {
			if (inTile.has(c)) queue.push([c, r + 1]);
		}
	}
	// Any path not reached (shouldn't happen) defaults to its own depth 0.
	for (const p of tilePaths) if (round[p] == null) round[p] = 0;
	return round;
}

// cut(r) = { nodes at round r } ∪ { leaves at round < r }. Complete cover of the tile.
function cutForRound(tilePaths, round, childrenOf, r, inTile) {
	const out = [];
	for (const p of tilePaths) {
		const isLeaf = !(childrenOf[p] || []).some((c) => inTile.has(c));
		if (round[p] === r || (isLeaf && round[p] < r)) out.push(p);
	}
	return out;
}

// Build the linear LOD chain for one tile from staged unmasked node OBJs.
function buildTilePyramid({ outputDir, stagingDir, tileName, tilePaths, childrenOf, parentOf, maxLevel }) {
	const tileDir = path.join(outputDir, "Data", tileName);
	fs.ensureDirSync(tileDir);
	const inTile = new Set(tilePaths);
	const round = computeRounds(tilePaths, childrenOf, parentOf);
	const maxRound = Math.max(...tilePaths.map((p) => round[p]));

	// Representative octree level per round (for the pixel threshold), = shallowest
	// path length among that round's frontier nodes.
	const levelOfRound = (r) => {
		const lens = tilePaths.filter((p) => round[p] === r).map((p) => p.length);
		return lens.length ? Math.min(...lens) : maxLevel;
	};

	const levelFile = (r) => (r === 0 ? `${tileName}.osgb` : `${tileName}_R${r}.osgb`);
	let built = 0;

	for (let r = maxRound; r >= 0; r--) {
		const cut = cutForRound(tilePaths, round, childrenOf, r, inTile);
		if (cut.length === 0) continue;
		const base = r === 0 ? `${tileName}_R0` : `${tileName}_R${r}`;
		const objPath = mergeNodesToObj(stagingDir, tileDir, base, cut);
		if (!objPath) continue;
		const bounds = readObjBounds(objPath);

		const outName = levelFile(r);
		if (r === maxRound) {
			// Finest level: terminal geode, no child to page.
			runOsgConv([path.basename(objPath), outName], tileDir);
		} else {
			const geodeScene = objToGeodeScene(objPath);
			const tempOsgt = path.join(tileDir, `_lvl_${r}.osgt`);
			writePagedLodOsgt({
				outputPath: tempOsgt,
				childFiles: [levelFile(r + 1)],
				geodeScene,
				center: bounds,
				rangeThreshold: pixelRangeForLevel(levelOfRound(r), maxLevel),
			});
			runOsgConv([path.basename(tempOsgt), outName], tileDir);
			fs.removeSync(tempOsgt);
		}
		// Clean the intermediate merged obj/mtl (textures are now inlined in the osgb).
		fs.removeSync(objPath);
		fs.removeSync(objPath.replace(/\.obj$/, ".mtl"));
		built++;
	}

	return { tileName, rounds: maxRound + 1, builtLevels: built };
}

async function buildLodPyramidRegion(outputDir, { index, maxLevel, onlyGridTiles = null }) {
	const stagingDir = path.join(outputDir, ".staging");
	const exportedPaths = Object.keys(index.nodes || {});
	const { childrenOf, parentOf } = buildLodTree(exportedPaths);
	const byTile = groupByTile(index);
	const gridFilter = onlyGridTiles ? new Set(onlyGridTiles) : null;

	const stats = { tiles: 0, levels: 0, errors: [], tileNames: [] };
	for (const [tileName, tilePaths] of byTile.entries()) {
		if (gridFilter && !gridFilter.has(tileName)) continue;
		try {
			const r = buildTilePyramid({
				outputDir, stagingDir, tileName, tilePaths, childrenOf, parentOf, maxLevel,
			});
			stats.tiles++;
			stats.levels += r.builtLevels;
			stats.tileNames.push(tileName);
		} catch (error) {
			stats.errors.push({ tileName, error: error.message || String(error) });
		}
	}
	stats.tileNames.sort();
	return stats;
}

module.exports = {
	runOsgConv,
	objToGeodeScene,
	extractTopNode,
	readMtlTextures,
	mergeNodesToObj,
	computeRounds,
	cutForRound,
	buildTilePyramid,
	buildLodPyramidRegion,
};
