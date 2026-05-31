"use strict";

// Rebuild the per-tile LOD pyramid (model C) from an already-staged region, WITHOUT
// re-downloading or re-decoding. Requires a prior `--pyramid` export that left the
// unmasked node meshes under <regionDir>/.staging/nodes/.
//
//   node scripts/build-pyramid.js <regionDir> [Tile_+XXX_+YYY ...]

const fs = require("fs");
const path = require("path");
const { buildLodPyramidRegion } = require("../lib/osgb-lod-pyramid");

async function main() {
	const regionDir = process.argv[2];
	if (!regionDir) {
		console.error("usage: node scripts/build-pyramid.js <regionDir> [Tile_... ...]");
		process.exit(2);
	}
	const onlyGridTiles = process.argv.slice(3);

	const indexFile = path.join(regionDir, ".region-osgb-index.json");
	if (!fs.existsSync(indexFile)) throw new Error(`Index not found: ${indexFile}`);
	if (!fs.existsSync(path.join(regionDir, ".staging", "nodes"))) {
		throw new Error("No .staging/nodes — run a --pyramid export first (staging is required).");
	}
	const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));

	const manifestPath = path.join(regionDir, "region-manifest.json");
	const maxLevel = fs.existsSync(manifestPath)
		? (JSON.parse(fs.readFileSync(manifestPath, "utf8")).maxLevel || 22)
		: 22;

	console.log(
		`Building pyramid from ${Object.keys(index.nodes || {}).length} staged nodes`
		+ (onlyGridTiles.length ? ` — only ${onlyGridTiles.join(", ")}` : " — all tiles"),
	);

	const stats = await buildLodPyramidRegion(regionDir, {
		index,
		maxLevel,
		onlyGridTiles: onlyGridTiles.length ? onlyGridTiles : null,
	});

	console.log("Pyramid build complete:");
	console.log(`  tiles:  ${stats.tiles}`);
	console.log(`  levels: ${stats.levels}`);
	if (stats.errors.length) {
		console.log(`  errors: ${stats.errors.length}`);
		for (const e of stats.errors.slice(0, 5)) console.log("   -", JSON.stringify(e));
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
