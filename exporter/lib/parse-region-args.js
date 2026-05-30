"use strict";

const path = require("path");
const { getDefaultConcurrency } = require("./async-pool");

function parseRegionArgs(argv) {
	const positional = [];
	const options = {
		dryRun: false,
		parallelSearch: true,
		workers: null,
		clip: true,
		resume: true,
		cache: true,
		convertOsgb: true,
		exportMode: "osgb",
		outputDir: null,
		epsg: "auto",
		rateLimitMs: 0,
		maxOctants: 50000,
		proxy: null,
		timeoutMs: 120000,
		geoOnly: false,
		tileGroupLevelRaw: "auto",
		maxNodesPerTile: null,
		recalibrate: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--parallel-search") options.parallelSearch = true;
		else if (arg === "--no-parallel") options.parallelSearch = false;
		else if (arg === "--no-merge-tiles") options.tileGroupLevelRaw = "off";
		else if (arg === "--tile-group-level") options.tileGroupLevelRaw = argv[++i];
		else if (arg === "--max-nodes-per-tile") options.maxNodesPerTile = parseInt(argv[++i], 10);
		else if (arg === "--serial") {
			options.parallelSearch = false;
			options.workers = 1;
			options.rateLimitMs = 100;
		}
		else if (arg === "--workers") options.workers = parseInt(argv[++i], 10);
		else if (arg === "--no-clip") options.clip = false;
		else if (arg === "--no-resume") options.resume = false;
		else if (arg === "--recalibrate") options.recalibrate = true;
		else if (arg === "--no-cache") options.cache = false;
		else if (arg === "--no-osgb") options.convertOsgb = false;
		else if (arg === "--obj-export") options.exportMode = "obj";
		else if (arg === "--output") options.outputDir = path.resolve(argv[++i]);
		else if (arg === "--epsg") options.epsg = argv[++i];
		else if (arg === "--rate-limit-ms") options.rateLimitMs = parseInt(argv[++i], 10);
		else if (arg === "--max-octants") options.maxOctants = parseInt(argv[++i], 10);
		else if (arg === "--proxy") options.proxy = argv[++i];
		else if (arg === "--timeout-ms") options.timeoutMs = parseInt(argv[++i], 10);
		else if (arg === "--geo-only") options.geoOnly = true;
		else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
		else positional.push(arg);
	}

	const [geojsonFile, maxLevelRaw = "auto"] = positional;
	if (!geojsonFile) {
		printUsage();
		process.exit(1);
	}

	const workers = options.workers && options.workers > 0
		? options.workers
		: getDefaultConcurrency();

	return {
		geojsonFile: path.resolve(geojsonFile),
		maxLevelRaw,
		...options,
		workers,
	};
}

function printUsage() {
	const invoc = "node dump_region.js";
	console.error("Usage:");
	console.error(`  ${invoc} [geojson_file] [max_level|auto] [options]`);
	console.error("");
	console.error("Options:");
	console.error("  --output <dir>         Output directory");
	console.error("  --epsg <code|auto>     Target projection, default auto");
	console.error("  --no-clip              Disable GeoJSON polygon clipping");
	console.error("  --no-resume            Disable download resume");
	console.error("  --recalibrate          Rebuild OSGB coords/tiles (keeps HTTP cache, clears Data/)");
	console.error("  --no-cache             Disable disk download cache");
	console.error("  --no-osgb              Skip final OSGB build (staging OBJ only)");
	console.error("  --obj-export             Legacy OBJ+PNG tile export instead of OSGB LOD");
	console.error("  --tile-group-level <n|auto|off>  Merge by octant prefix (default auto = L18 for L22)");
	console.error("  --max-nodes-per-tile <n>         Spatially split tile after N nodes (default off)");
	console.error("  --no-merge-tiles               One OBJ per leaf node (legacy behavior)");
	console.error("  --workers <n>          Parallel workers (default: CPU core count)");
	console.error("  --parallel-search      Parallel octree traversal (default on)");
	console.error("  --no-parallel          Disable parallel octree traversal");
	console.error("  --serial               Single-threaded mode (workers=1, rate limit 100ms)");
	console.error("  --rate-limit-ms <n>    Minimum interval between HTTP request starts");
	console.error("  --max-octants <n>      Maximum allowed octants");
	console.error("  --proxy <url>          HTTP/SOCKS proxy, e.g. http://127.0.0.1:7890");
	console.error("  --timeout-ms <n>       Request timeout (default 120000)");
	console.error("  --geo-only             Resolve octants by geometry only, skip online verify");
	console.error("  --dry-run              Resolve octants only");
	console.error("");
	console.error("Examples:");
	console.error(`  ${invoc} examples/google_hq.geojson auto`);
	console.error(`  ${invoc} examples/google_hq.geojson 16 --epsg 4547 --output ./output/hq`);
}

module.exports = {
	parseRegionArgs,
	printUsage,
};
