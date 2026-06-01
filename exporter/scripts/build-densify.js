"use strict";

// Rebuild the densified per-node dual-geode pyramid (model 3) from an already-staged
// region (requires a prior `--pyramid` export that left .staging/nodes/*/node.obj and
// .../_masked/node.obj). No re-download / re-decode.
//
//   node scripts/build-densify.js <regionDir> [Tile_+XXX_+YYY ...]

const fs = require("fs");
const path = require("path");
const { buildDensifiedPyramidRegion } = require("../lib/osgb-densify-pyramid");

async function main() {
	const regionDir = process.argv[2];
	if (!regionDir) {
		console.error("usage: node scripts/build-densify.js <regionDir> [Tile_... ...]");
		process.exit(2);
	}
	const onlyGridTiles = process.argv.slice(3);

	const indexFile = path.join(regionDir, ".region-osgb-index.json");
	if (!fs.existsSync(indexFile)) throw new Error(`Index not found: ${indexFile}`);
	if (!fs.existsSync(path.join(regionDir, ".staging", "nodes"))) {
		throw new Error("No .staging/nodes — run a --pyramid export first.");
	}
	const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
	const manifestPath = path.join(regionDir, "region-manifest.json");
	const maxLevel = fs.existsSync(manifestPath)
		? (JSON.parse(fs.readFileSync(manifestPath, "utf8")).maxLevel || 22)
		: 22;

	console.log(
		`Densifying ${Object.keys(index.nodes || {}).length} staged nodes`
		+ (onlyGridTiles.length ? ` — only ${onlyGridTiles.join(", ")}` : " — all tiles"),
	);
	const stats = await buildDensifiedPyramidRegion(regionDir, {
		index,
		maxLevel,
		onlyGridTiles: onlyGridTiles.length ? onlyGridTiles : null,
	});
	console.log("Densify build complete:");
	console.log(`  tiles:      ${stats.tiles}`);
	console.log(`  node files: ${stats.nodes}`);
	console.log(`  root files: ${stats.rootFiles}`);
	if (stats.errors.length) {
		console.log(`  errors:     ${stats.errors.length}`);
		for (const e of stats.errors.slice(0, 5)) console.log("   -", JSON.stringify(e));
		process.exitCode = 1;
	}
}

main().catch((err) => { console.error(err); process.exit(1); });
