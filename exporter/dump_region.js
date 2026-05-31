"use strict";

const fs = require("fs-extra");
const path = require("path");

const { getBboxFromGeoJSON } = require("./lib/geojson-bbox");
const { getPolygonsFromGeoJSON, createClipFilter } = require("./lib/geojson-clip");
const { normalizeGeoJSON } = require("./lib/geojson-normalize");
const bboxToOctantsFactory = require("./lib/bbox-to-octants");
const { createDumpCore } = require("./lib/dump-core");
const { recommendMaxLevel, recommendOctantStartLevel, bboxAreaMeters } = require("./lib/level-recommend");
const { resolveEpsg, createCoordinateTransform, buildSrsMetadata, DEFAULT_GLOBE_RADIUS, isEngineeringCrs } = require("./lib/coords");
const { createProgressTracker } = require("./lib/download-cache");
const { writeMetadataXml } = require("./lib/metadata-xml");
const { convertAllTiles, findOsgConv } = require("./lib/osgb-convert");
const { parseRegionArgs } = require("./lib/parse-region-args");
const getUrl = require("./lib/get-url");
const { getDefaultConcurrency } = require("./lib/async-pool");
const { parseTileGroupLevel, approximateBlockSizeMeters, DEFAULT_MAX_NODES_PER_TILE } = require("./lib/tile-group");
const { recommendOsgbGridCellSize } = require("./lib/osgb-grid");

const PLANET = "earth";
const URL_PREFIX = `https://kh.google.com/rt/${PLANET}/`;
const DL_DIR = "./downloaded_files";

function buildOutputDir(args, octants, maxLevel, rootEpoch) {
	if (args.outputDir) return args.outputDir;
	const baseName = path.basename(args.geojsonFile, path.extname(args.geojsonFile));
	return path.join(DL_DIR, "regions", `${baseName}-L${maxLevel}-${rootEpoch}`);
}

async function run() {
	const args = parseRegionArgs(process.argv.slice(2));
	const exportAbort = { requested: false };
	let forceExitTimer = null;
	process.on("SIGINT", () => {
		if (exportAbort.requested) {
			console.error("\nForce quit.");
			process.exit(130);
		}
		exportAbort.requested = true;
		console.error("\nInterrupt received — stopping discovery and saving partial OSGB...");
		forceExitTimer = setTimeout(() => {
			console.error("Partial save is taking too long. Press Ctrl+C again to force quit.");
		}, 120000);
	});
	process.on("SIGTERM", () => {
		exportAbort.requested = true;
	});
	const geojsonText = fs.readFileSync(args.geojsonFile, "utf8");
	const normalized = normalizeGeoJSON(geojsonText);
	if (normalized.reprojected) {
		console.log(`GeoJSON reprojected: ${normalized.sourceCrs} -> EPSG:4326`);
	}
	const bbox = getBboxFromGeoJSON(normalized.data);
	const polygons = getPolygonsFromGeoJSON(normalized.data);
	const maxLevel = recommendMaxLevel(bbox, args.maxLevelRaw);
	const exportMode = args.exportMode === "obj" ? "obj" : "osgb";
	const tileGroupLevel = exportMode === "obj"
		? (args.tileGroupLevelRaw === "off"
			? null
			: parseTileGroupLevel(args.tileGroupLevelRaw, maxLevel, bbox))
		: null;
	const startLevel = recommendOctantStartLevel(bbox, maxLevel);
	const clipFilter = createClipFilter(polygons, args.clip);
	const verifyOnline = !args.geoOnly && !args.dryRun;
	const epsgOption = args.epsg;
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const epsgInfo = resolveEpsg(epsgOption, centerLon, centerLat, {
		sourceCrs: normalized.sourceCrs,
	});

	const cacheDir = args.cache ? path.join(DL_DIR, "cache") : null;
	const bulkConcurrency = Math.min(Math.max(Math.floor(args.workers / 2), 8), 16);
	const nodeConcurrency = Math.min(args.workers, 20);
	const utils = require("./lib/utils")({
		URL_PREFIX,
		DUMP_JSON_DIR: null,
		DUMP_RAW_DIR: null,
		DUMP_JSON: false,
		DUMP_RAW: false,
		CACHE_DIR: cacheDir,
		RATE_LIMIT_MS: args.rateLimitMs,
		PROXY: args.proxy,
		TIMEOUT_MS: args.timeoutMs,
		NODE_TIMEOUT_MS: 60000,
		BULK_CONCURRENCY: bulkConcurrency,
		NODE_CONCURRENCY: nodeConcurrency,
	});

	let globeRadius = DEFAULT_GLOBE_RADIUS;
	if (!args.dryRun) {
		const planetoidMeta = await utils.getPlanetoid();
		if (planetoidMeta && planetoidMeta.radius) {
			globeRadius = planetoidMeta.radius;
		}
	}

	const srs = buildSrsMetadata(epsgInfo, bbox);
	const coordinateTransform = createCoordinateTransform(epsgInfo, bbox, globeRadius);
	const bboxToOctants = bboxToOctantsFactory(utils);
	const dumpCore = createDumpCore(utils);

	console.log("GeoJSON file:", args.geojsonFile);
	console.log("BBox:", bbox);
	console.log("Area (m²):", Math.round(bboxAreaMeters(bbox)));
	console.log("Max level:", maxLevel, args.maxLevelRaw === "auto" ? "(auto)" : "");
	console.log("Export format:", exportMode === "osgb" ? "OSGB PagedLOD" : "OBJ tiles");
	if (exportMode === "obj") {
		if (tileGroupLevel) {
			console.log(
				"Tile group level:",
				tileGroupLevel,
				`(~${Math.round(approximateBlockSizeMeters(tileGroupLevel))}m blocks, spatial merge)`,
			);
			if (args.maxNodesPerTile) {
				console.log("Max nodes per tile (spatial overflow):", args.maxNodesPerTile);
			}
		} else {
			console.log("Tile merge: off (one tile per leaf node)");
		}
	} else {
		console.log("LOD tree: L16..L" + maxLevel + ` PagedLOD with grid tiles Tile_+XXX_+YYY (${recommendOsgbGridCellSize(maxLevel)}m cells)`);
	}
	console.log("Octant start level:", startLevel, `(expand to L${maxLevel})`);
	if (args.maxLevelRaw === "auto" && maxLevel < 22) {
		console.log(`Hint: pass explicit max level for highest detail, e.g. ${path.basename(process.argv[1])} ${path.basename(args.geojsonFile)} 22`);
	}
	console.log("Clip to polygon:", clipFilter.enabled);
	console.log("Octant verify:", verifyOnline ? "online" : "geo-only");
	if (args.proxy || getUrl.getConfiguredProxy()) {
		console.log("Proxy:", args.proxy || getUrl.getConfiguredProxy());
	}
	if (normalized.sourceCrs && normalized.sourceCrs !== "EPSG:4326") {
		if (args.epsg !== "auto") {
			console.log("GeoJSON CRS:", normalized.sourceCrs, `(CLI overrides export with ${srs.epsg})`);
		} else if (isEngineeringCrs(normalized.sourceCrs) && srs.epsg === normalized.sourceCrs) {
			console.log("GeoJSON export CRS:", normalized.sourceCrs, "(auto)");
		} else {
			console.log("GeoJSON CRS:", normalized.sourceCrs, `(Web Mercator; export falls back to ${srs.epsg} for correct metric scale)`);
		}
	}
	if (args.epsg === "auto" && exportMode === "osgb" && normalized.sourceCrs === "EPSG:4326") {
		console.log("Coordinate system:", srs.epsg, "(GeoJSON has no projected CRS; auto UTM. Declare CRS in GeoJSON or use --epsg)");
	} else if (srs.epsg && srs.epsg.startsWith("ENU:")) {
		console.log("Coordinate system:", srs.epsg, "(local ENU meters)");
	} else {
		console.log("Coordinate system:", srs.epsg, "(region-local vertices relative to SRSOrigin)");
	}
	console.log("Globe radius (m):", globeRadius);
	console.log("SRSOrigin:", srs.srsOrigin.map((v) => Math.round(v * 1000) / 1000).join(", "));
	console.log("Workers:", args.workers, `(CPU cores: ${getDefaultConcurrency()})`);
	console.log("Parallel search:", args.parallelSearch);
	console.log("HTTP bulk concurrency:", bulkConcurrency);
	console.log("HTTP node concurrency:", nodeConcurrency);
	if (args.rateLimitMs > 0) console.log("Rate limit (ms):", args.rateLimitMs);
	if (cacheDir) {
		console.log("HTTP cache:", path.resolve(cacheDir), "(raw downloads only)");
		console.log("Note: cache files != exported tiles; OBJ/OSGB appear under --output after each node is processed.");
	}

	const octants = await bboxToOctants(bbox, maxLevel, { verifyOnline });
	console.log(`Found ${octants.length} octant(s)`);

	if (octants.length === 0) {
		throw new Error("No octants found for this region. Try a lower max_level or a different area.");
	}
	if (octants.length > args.maxOctants) {
		throw new Error(`Too many octants (${octants.length}). Limit is ${args.maxOctants}. Use a smaller GeoJSON or lower max_level.`);
	}

	for (const octant of octants) {
		console.log("  ", octant);
	}

	if (args.dryRun) {
		const outputDir = args.outputDir || path.join(DL_DIR, "regions", `${path.basename(args.geojsonFile, path.extname(args.geojsonFile))}-L${maxLevel}-preview`);
		const manifest = {
			version: "1.0.0",
			sourceGeoJSON: args.geojsonFile,
			bbox,
			areaMeters: bboxAreaMeters(bbox),
			maxLevel,
			tileGroupLevel,
			octants,
			clipEnabled: clipFilter.enabled,
			srs: {
				epsg: srs.epsg,
				description: srs.description,
				srsOrigin: srs.srsOrigin,
				center: srs.center,
			},
			output: {
				format: "osgb",
				directory: outputDir,
			},
		};
		console.log("\nDry run only. Manifest preview:");
		console.log(JSON.stringify(manifest, null, 2));
		console.log("\nosgconv available:", !!findOsgConv());
		return;
	}

	const planetoid = await utils.getPlanetoid();
	const rootEpoch = planetoid.bulkMetadataEpoch[0];
	const outputDir = buildOutputDir(args, octants, maxLevel, rootEpoch);
	const progressFile = path.join(outputDir, ".region-progress.json");

	if (exportMode === "osgb" && args.recalibrate) {
		console.log("Recalibrate: clearing OSGB tiles and progress (HTTP cache kept)...");
		await fs.remove(path.join(outputDir, "Data"));
		await fs.ensureDir(path.join(outputDir, "Data"));
		const indexFile = path.join(outputDir, ".region-osgb-index.json");
		if (await fs.pathExists(indexFile)) {
			await fs.writeJson(indexFile, { nodes: {}, childMap: {} }, { spaces: 2 });
		}
		const checkpointFile = path.join(outputDir, ".region-osgb-checkpoint.json");
		if (await fs.pathExists(checkpointFile)) await fs.remove(checkpointFile);
		if (await fs.pathExists(progressFile)) await fs.remove(progressFile);
		args.resume = false;
	}

	const progressTracker = args.resume
		? createProgressTracker(progressFile, outputDir, {
			tileGroupLevel,
			exportMode: exportMode === "osgb" ? "osgb" : "tiles",
		})
		: null;
	let resumeStats = null;
	if (progressTracker) {
		resumeStats = await progressTracker.init();
	}

	const manifest = {
		version: "1.0.0",
		sourceGeoJSON: args.geojsonFile,
		bbox,
		areaMeters: bboxAreaMeters(bbox),
		maxLevel,
		tileGroupLevel,
		octants,
		clipEnabled: clipFilter.enabled,
		srs: {
			epsg: srs.epsg,
			description: srs.description,
			srsOrigin: srs.srsOrigin,
			center: srs.center,
		},
		output: {
			format: "osgb",
			directory: outputDir,
		},
	};

	fs.ensureDirSync(outputDir);
	fs.ensureDirSync(path.join(outputDir, "Data"));
	writeMetadataXml(outputDir, {
		epsgCode: srs.epsg,
		srsOrigin: srs.srsOrigin,
	});
	fs.writeJsonSync(path.join(outputDir, "region-manifest.json"), {
		...manifest,
		status: "in_progress",
	}, { spaces: 2 });

	console.log("\nOutput directory:", path.resolve(outputDir));
	if (resumeStats) {
		const tileLabel = resumeStats.mergedTiles ? "merged tile(s)" : "tile(s)";
		console.log(
			`Resume: ${resumeStats.onDisk} ${tileLabel} on disk, `
			+ `${resumeStats.progressAfter} leaf node(s) already exported `
			+ `(progress ${resumeStats.progressBefore} -> ${resumeStats.progressAfter})`,
		);
	}
	console.log(
		exportMode === "osgb"
			? "Pipeline: stream nodes -> osgconv -> Data/*.osgb (parallel convert pool)"
			: "Pipeline: discover + export in parallel (NodeData -> merged OBJ tiles)",
	);
	console.log("Downloading and exporting...");

	if (exportMode === "osgb" && args.convertOsgb && !findOsgConv()) {
		throw new Error("osgconv not found. Install OpenSceneGraph or use --obj-export for legacy OBJ output.");
	}

	const dumpResult = await dumpCore.dumpOctants({
		octants,
		maxLevel,
		parallelSearch: args.parallelSearch,
		workers: args.workers,
		outputMode: "tiles",
		outputDir,
		coordinateTransform,
		clipFilter,
		progressTracker,
		regionBbox: bbox,
		transformConfig: {
			epsgInfo,
			bbox,
			globeRadius,
			epsgCode: srs.epsg,
			srsOrigin: srs.srsOrigin,
		},
		clipPolygons: polygons,
		tileGroupLevel,
		maxNodesPerTile: args.maxNodesPerTile,
		pyramidMode: args.pyramid,
		exportMode: exportMode === "osgb" ? "osgb" : "obj",
		shouldAbort: () => exportAbort.requested,
	});

	if (forceExitTimer) clearTimeout(forceExitTimer);

	manifest.status = dumpResult.partial ? "partial" : "complete";
	manifest.download = {
		rootEpoch,
		nodeCount: dumpResult.nodeCount,
		exportedCount: dumpResult.exportedCount,
		skippedCount: dumpResult.skippedCount || 0,
		failedCount: dumpResult.failedCount || 0,
		emptyCount: dumpResult.emptyCount || 0,
		exportMode,
		mergedTileCount: dumpResult.mergedTileCount || 0,
		tileCount: exportMode === "osgb"
			? (dumpResult.osgb?.gridTileNames || []).length
			: dumpResult.tileNames.length,
		tiles: exportMode === "osgb"
			? (dumpResult.osgb?.gridTileNames || [])
			: dumpResult.tileNames,
		childMap: dumpResult.childMap,
	};
	if (dumpResult.osgb) {
		manifest.osgb = dumpResult.osgb;
		console.log(
			`OSGB: ${dumpResult.osgb.gridTiles || 0} grid tiles, `
			+ `${dumpResult.osgb.nodeFiles || 0} flat nodes, `
			+ `${dumpResult.osgb.wrappedFiles || 0} PagedLOD wrapped, `
			+ `${dumpResult.osgb.rootFiles || 0} roots`,
		);
		if (dumpResult.osgb.errors?.length > 0) {
			console.warn("OSGB errors (first 5):", dumpResult.osgb.errors.slice(0, 5));
		}
	} else if (exportMode === "obj" && args.convertOsgb) {
		console.log("\nConverting tiles to OSGB...");
		const osgbResult = convertAllTiles(outputDir);
		manifest.osgb = osgbResult;
		if (!osgbResult.osgConvAvailable) {
			console.warn(osgbResult.message || "osgconv not available; OBJ tiles were kept under Data/");
		} else {
			console.log(`OSGB converted: ${osgbResult.converted}, failed: ${osgbResult.failed}, skipped: ${osgbResult.skipped}`);
		}
	}

	fs.writeJsonSync(path.join(outputDir, "region-manifest.json"), manifest, { spaces: 2 });

	console.log("\nRegion export complete.");
	console.log("Output directory:", path.resolve(outputDir));
	console.log("Structure:");
	console.log("  metadata.xml");
	console.log("  region-manifest.json");
	if (exportMode === "osgb") {
		console.log("  Data/Tile_+XXX_+YYY/Tile_+XXX_+YYY.osgb (PagedLOD root)");
		console.log("  Data/Tile_+XXX_+YYY/Tile_+XXX_+YYY_L*.osgb (LOD chain)");
	} else {
		console.log("  Data/Tile_*/Tile_*.obj|.osgb");
	}
}

(async function program() {
	await run();
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
