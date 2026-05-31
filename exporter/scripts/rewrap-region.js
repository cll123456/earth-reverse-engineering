"use strict";

// Fully re-wrap the PagedLOD chain of an already-exported region from the saved
// index, WITHOUT re-downloading or re-decoding anything. Use this after changing
// the PagedLOD generation logic (RangeMode / switch distances) in osgb-paged-lod.js.
//
//   node scripts/rewrap-region.js <regionDir> [Tile_+XXX_+YYY ...]
//
// With no tile names it re-wraps every tile. Pass one or more tile folder names to
// re-wrap just those (fast iteration / single-tile validation in DasViewer).
//
// incremental:false forces every non-leaf node to be re-wrapped even if it was
// already flat===false, so stale pixel-size wraps from earlier runs are replaced.

const fs = require("fs");
const path = require("path");
const { finalizePagedLodRegion } = require("../lib/osgb-paged-lod");

async function main() {
	const regionDir = process.argv[2];
	if (!regionDir) {
		console.error("usage: node scripts/rewrap-region.js <regionDir> [Tile_... ...]");
		process.exit(2);
	}
	const onlyGridTiles = process.argv.slice(3);

	const indexPath = path.join(regionDir, ".region-osgb-index.json");
	if (!fs.existsSync(indexPath)) {
		throw new Error(`Index not found: ${indexPath}`);
	}
	const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
	const nodeCount = Object.keys(index.nodes || {}).length;

	const manifestPath = path.join(regionDir, "region-manifest.json");
	const maxLevel = fs.existsSync(manifestPath)
		? (JSON.parse(fs.readFileSync(manifestPath, "utf8")).maxLevel || 22)
		: 22;

	console.log(
		`Re-wrapping ${nodeCount} nodes (maxLevel=${maxLevel})`
		+ (onlyGridTiles.length ? ` — only ${onlyGridTiles.join(", ")}` : " — all tiles"),
	);

	const stats = await finalizePagedLodRegion(regionDir, {
		index,
		maxLevel,
		incremental: false,
		rootsOnly: false,
		saveIndex: true,
		onlyGridTiles: onlyGridTiles.length ? onlyGridTiles : null,
	});

	console.log("Re-wrap complete:");
	console.log(`  grid tiles:    ${stats.gridTiles}`);
	console.log(`  wrapped files: ${stats.wrappedFiles}`);
	console.log(`  root files:    ${stats.rootFiles}`);
	if (stats.errors.length) {
		console.log(`  errors:        ${stats.errors.length}`);
		for (const e of stats.errors.slice(0, 5)) console.log("   -", JSON.stringify(e));
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
