"use strict";

// Rebuild the densified per-node dual-geode pyramid (model 3) from an already-staged
// region (requires a prior `--pyramid` export that left .staging/nodes/*/node.obj and
// .../_masked/node.obj). No re-download / re-decode.
//
//   node scripts/build-densify.js <regionDir> [Tile_+XXX_+YYY ...]

const fs = require("fs");
const path = require("path");
const { buildDensifiedPyramidRegion, finalizeDensifiedWrappers } = require("../lib/osgb-densify-pyramid");

async function main() {
	const regionDir = process.argv[2];
	if (!regionDir) {
		console.error("usage: node scripts/build-densify.js <regionDir> [Tile_... ...]");
		process.exit(2);
	}
	const onlyGridTiles = process.argv.slice(3);

	const indexFile = path.join(regionDir, ".region-osgb-index.json");
	if (!fs.existsSync(indexFile)) throw new Error(`Index not found: ${indexFile}`);
	// Staging is pruned during streaming by default (ERE_KEEP_STAGING=1 keeps it). Without
	// it we can't rebuild the geodes, but we CAN still finalize: rebuild the internal-node
	// wrappers + tile roots from the geodes already in Data/ + the index. That alone makes a
	// streamed (or interrupted) region importable in DasViewer.
	const hasStaging = fs.existsSync(path.join(regionDir, ".staging", "nodes"));
	const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
	const manifestPath = path.join(regionDir, "region-manifest.json");
	const maxLevel = fs.existsSync(manifestPath)
		? (JSON.parse(fs.readFileSync(manifestPath, "utf8")).maxLevel || 22)
		: 22;

	const opts = { index, maxLevel, onlyGridTiles: onlyGridTiles.length ? onlyGridTiles : null };
	const nodeCount = Object.keys(index.nodes || {}).length;
	const tileScope = onlyGridTiles.length ? ` — only ${onlyGridTiles.join(", ")}` : " — all tiles";
	let stats;
	if (hasStaging) {
		console.log(`Densifying ${nodeCount} staged nodes${tileScope}`);
		stats = await buildDensifiedPyramidRegion(regionDir, opts);
	} else {
		console.log(`No .staging — finalize only: rebuilding wrappers + tile roots for ${nodeCount} nodes${tileScope}`);
		stats = await finalizeDensifiedWrappers(regionDir, opts);
	}
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
