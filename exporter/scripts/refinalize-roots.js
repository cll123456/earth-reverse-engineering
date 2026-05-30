"use strict";

// Rebuild only the per-tile root PagedLOD files (Tile_+XXX_+YYY.osgb) from the
// saved region index, using the current (fixed) mergeIndexBounds. Leaf osgb and
// the wrapped LOD chain are left untouched, so no re-download/re-convert happens.

const fs = require("fs");
const path = require("path");
const { finalizePagedLodRegion } = require("../lib/osgb-paged-lod");

async function main() {
	const outputDir = process.argv[2]
		|| "./downloaded_files/regions/google_hq-L22-osgb";
	const maxLevel = parseInt(process.argv[3] || "22", 10);

	const indexPath = path.join(outputDir, ".region-osgb-index.json");
	if (!fs.existsSync(indexPath)) {
		throw new Error(`Index not found: ${indexPath}`);
	}
	const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
	const nodeCount = Object.keys(index.nodes || {}).length;
	console.log(`Loaded index: ${nodeCount} nodes, maxLevel=${maxLevel}`);

	const stats = await finalizePagedLodRegion(outputDir, {
		index,
		maxLevel,
		rootsOnly: true,
		saveIndex: false,
	});

	console.log("Root rebuild complete:");
	console.log(`  grid tiles: ${stats.gridTiles}`);
	console.log(`  root files written: ${stats.rootFiles}`);
	if (stats.errors.length) {
		console.log(`  errors: ${stats.errors.length}`);
		for (const e of stats.errors.slice(0, 5)) console.log("   -", JSON.stringify(e));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
