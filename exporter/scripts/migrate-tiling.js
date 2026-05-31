"use strict";

// Migrate an existing OSGB export from the old per-node-center tiling to the new
// L16-anchor tiling, then rebuild the PagedLOD chain — WITHOUT re-downloading.
//
// Old exports scattered one octree subtree across several Tile_* folders, so the
// finalizer could only flat-load every leaf at once (DasViewer crash). The new
// layout puts a whole subtree (the L16 anchor + all descendants) in one folder so
// parent->child PagedLOD references stay same-directory and a real coarse->fine
// pyramid can be built.
//
// Usage: node scripts/migrate-tiling.js <outputDir> [maxLevel]

const fs = require("fs-extra");
const path = require("path");
const {
	DEFAULT_LOD_PREFIX_LEVEL,
	DEFAULT_GRID_ANCHOR_LEVEL,
	buildOsgbFileName,
	parseGridTileName,
} = require("../lib/osgb-grid");
const { finalizePagedLodRegion } = require("../lib/osgb-paged-lod");

function anchorPathFor(pathName, anchorLevel) {
	return pathName.length > anchorLevel ? pathName.substring(0, anchorLevel) : pathName;
}

async function migrate(outputDir, {
	lodPrefixLevel = DEFAULT_LOD_PREFIX_LEVEL,
	anchorLevel = DEFAULT_GRID_ANCHOR_LEVEL,
} = {}) {
	const indexFile = path.join(outputDir, ".region-osgb-index.json");
	if (!await fs.pathExists(indexFile)) {
		throw new Error(`Index not found: ${indexFile}`);
	}
	const index = await fs.readJson(indexFile);
	const dataDir = path.join(outputDir, "Data");
	const nodes = index.nodes || {};
	const paths = Object.keys(nodes);

	// New tile of a node = the current tile of its L16 anchor. The anchor node was
	// itself tiled by its own center under the old code, which is exactly what the
	// new code computes for it, so this reproduces the new tiling without redoing
	// any projection math.
	function newTileFor(pathName) {
		const anchor = anchorPathFor(pathName, anchorLevel);
		return nodes[anchor]?.gridTile || nodes[pathName].gridTile;
	}

	const moves = [];
	for (const pathName of paths) {
		const entry = nodes[pathName];
		if (!entry || !entry.osgbFile) continue;
		const oldTile = entry.gridTile;
		const oldFile = entry.osgbFile;
		const newTile = newTileFor(pathName);
		const newFile = buildOsgbFileName(newTile, pathName, lodPrefixLevel);
		if (newTile === oldTile && newFile === oldFile) continue;
		moves.push({ pathName, oldTile, oldFile, newTile, newFile });
	}

	console.log(`Nodes: ${paths.length}, files to relocate: ${moves.length}`);

	let moved = 0;
	let missing = 0;
	for (const m of moves) {
		const src = path.join(dataDir, m.oldTile, m.oldFile);
		const dst = path.join(dataDir, m.newTile, m.newFile);
		if (!await fs.pathExists(src)) {
			missing++;
			// Still update the index so the node points at where it should live.
			nodes[m.pathName].gridTile = m.newTile;
			nodes[m.pathName].osgbFile = m.newFile;
			continue;
		}
		await fs.ensureDir(path.join(dataDir, m.newTile));
		await fs.move(src, dst, { overwrite: true });
		nodes[m.pathName].gridTile = m.newTile;
		nodes[m.pathName].osgbFile = m.newFile;
		moved++;
	}
	console.log(`Relocated ${moved} file(s)${missing ? `, ${missing} missing on disk (index updated)` : ""}`);

	// Drop every stale per-tile root (Tile_X/Tile_X.osgb) and the wrapped flat flag,
	// so finalize rebuilds the whole chain from the geode geometry.
	let removedRoots = 0;
	for (const tileName of await fs.readdir(dataDir)) {
		if (!parseGridTileName(tileName)) continue;
		const rootFile = path.join(dataDir, tileName, `${tileName}.osgb`);
		if (await fs.pathExists(rootFile)) {
			await fs.remove(rootFile);
			removedRoots++;
		}
	}
	for (const entry of Object.values(nodes)) {
		delete entry.flat;
	}
	console.log(`Removed ${removedRoots} stale root file(s)`);

	// Remove tile folders that no longer hold any node.
	const liveTiles = new Set(Object.values(nodes).map((e) => e.gridTile));
	let removedDirs = 0;
	for (const tileName of await fs.readdir(dataDir)) {
		if (!parseGridTileName(tileName)) continue;
		if (liveTiles.has(tileName)) continue;
		const dir = path.join(dataDir, tileName);
		const remaining = await fs.readdir(dir);
		if (remaining.length === 0) {
			await fs.remove(dir);
			removedDirs++;
		}
	}
	if (removedDirs) console.log(`Removed ${removedDirs} empty tile folder(s)`);

	await fs.writeJson(indexFile, index, { spaces: 2 });
	return { index, tileCount: liveTiles.size };
}

async function main() {
	const outputDir = process.argv[2];
	if (!outputDir) {
		throw new Error("Usage: node scripts/migrate-tiling.js <outputDir> [maxLevel]");
	}
	const { index, tileCount } = await migrate(outputDir);

	const finest = Math.max(
		1,
		...Object.keys(index.nodes || {}).map((p) => p.length),
	);
	const maxLevel = parseInt(process.argv[3] || String(finest), 10);
	console.log(`\nRebuilding PagedLOD pyramid (${tileCount} tiles, maxLevel=${maxLevel})...`);

	const stats = await finalizePagedLodRegion(outputDir, {
		index,
		maxLevel,
		rootsOnly: false,
		incremental: false,
		saveIndex: true,
	});

	console.log("Done:");
	console.log(`  grid tiles : ${stats.gridTiles}`);
	console.log(`  wrapped    : ${stats.wrappedFiles}`);
	console.log(`  roots      : ${stats.rootFiles}`);
	console.log(`  skipped    : ${stats.skipped}`);
	if (stats.errors.length) {
		console.log(`  errors     : ${stats.errors.length}`);
		for (const e of stats.errors.slice(0, 5)) console.log("   -", JSON.stringify(e));
	}
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}

module.exports = { migrate };
