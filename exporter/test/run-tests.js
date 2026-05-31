"use strict";

const assert = require("assert");
const path = require("path");
const { getBboxFromGeoJSON } = require("../lib/geojson-bbox");
const { getPolygonsFromGeoJSON, pointInPolygon, createClipFilter } = require("../lib/geojson-clip");
const { normalizeGeoJSON } = require("../lib/geojson-normalize");
const { recommendMaxLevel, bboxAreaMeters } = require("../lib/level-recommend");
const { ecefToWgs84, resolveEpsg, buildSrsMetadata, createCoordinateTransform, createEnuTransform } = require("../lib/coords");
const { boxesIntersect, subdivide } = require("../lib/octant-geo");

function test(name, fn) {
	tests.push({ name, fn });
}

const tests = [];

async function runAllTests() {
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`ok - ${name}`);
		} catch (error) {
			console.error(`fail - ${name}`);
			throw error;
		}
	}
	console.log("\nAll tests passed.");
}

const sampleGeoJSON = {
	type: "Feature",
	geometry: {
		type: "Polygon",
		coordinates: [[
			[-122.0895, 37.4185],
			[-122.0785, 37.4185],
			[-122.0785, 37.4235],
			[-122.0895, 37.4235],
			[-122.0895, 37.4185],
		]],
	},
};

test("geojson bbox", () => {
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	assert.strictEqual(bbox.west, -122.0895);
	assert.strictEqual(bbox.north, 37.4235);
});

test("geojson polygons", () => {
	const polygons = getPolygonsFromGeoJSON(sampleGeoJSON);
	assert.strictEqual(polygons.length, 1);
	assert.strictEqual(polygons[0][0].length, 5);
});

test("point in polygon", () => {
	const polygons = getPolygonsFromGeoJSON(sampleGeoJSON);
	assert.strictEqual(pointInPolygon(-122.084, 37.42, polygons[0]), true);
	assert.strictEqual(pointInPolygon(-122.2, 37.42, polygons[0]), false);
});

test("clip filter keeps interior triangle", () => {
	const polygons = getPolygonsFromGeoJSON(sampleGeoJSON);
	const clip = createClipFilter(polygons, true);
	assert.strictEqual(clip.keepTriangle(
		{ lon: -122.084, lat: 37.42 },
		{ lon: -122.083, lat: 37.42 },
		{ lon: -122.084, lat: 37.421 }
	), true);
	assert.strictEqual(clip.keepTriangle(
		{ lon: -122.2, lat: 37.42 },
		{ lon: -122.21, lat: 37.42 },
		{ lon: -122.2, lat: 37.421 }
	), false);
	assert.strictEqual(clip.keepTriangle(
		{ lon: -122.084, lat: 37.42 },
		{ lon: -122.2, lat: 37.42 },
		{ lon: -122.21, lat: 37.421 }
	), true);
});

test("level recommendation", () => {
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const level = recommendMaxLevel(bbox, "auto");
	assert.ok(level >= 15 && level <= 22);
	assert.strictEqual(recommendMaxLevel(bbox, "22"), 22);
});

test("enu export vertex remaps for iFreedo osgconv axis", () => {
	const { enuToObjVertex } = require("../lib/coords");
	const obj = enuToObjVertex(100, 200, 50);
	assert.deepStrictEqual(obj, { x: 100, y: 50, z: -200 });
});

test("obj bounds convert to osgb space for paged lod", () => {
	const { objBoundsToOsgbBounds } = require("../lib/osgb-paged-lod");
	const bounds = objBoundsToOsgbBounds(90, 40, -210, 110, 60, -190);
	assert.deepStrictEqual(bounds, { cx: 100, cy: 200, cz: 50, radius: Math.sqrt(20 ** 2 + 20 ** 2 + 20 ** 2) / 2 });
});

test("merge index bounds keeps osgb axes (no second swap)", () => {
	const { mergeIndexBounds } = require("../lib/osgb-paged-lod");
	// Two leaf nodes in OSGB space: X=east, Y=north, Z=up. Up is small (~-10),
	// north is large negative (~-200) — same layout the exporter produces.
	const index = {
		nodes: {
			a: { bounds: { cx: -1890, cy: -200, cz: -10, radius: 5 } },
			b: { bounds: { cx: -1830, cy: -200, cz: -10, radius: 5 } },
		},
	};
	const merged = mergeIndexBounds(["a", "b"], index);
	// Center must stay near the children: east ~-1860, north ~-200, up ~-10.
	assert.ok(Math.abs(merged.cx + 1860) < 1, `cx ${merged.cx}`);
	assert.ok(Math.abs(merged.cy + 200) < 1, `cy ${merged.cy} should stay ~-200 (north)`);
	assert.ok(Math.abs(merged.cz + 10) < 1, `cz ${merged.cz} should stay ~-10 (up)`);
	// The merged sphere must actually contain each child center.
	for (const key of ["a", "b"]) {
		const c = index.nodes[key].bounds;
		const d = Math.hypot(merged.cx - c.cx, merged.cy - c.cy, merged.cz - c.cz);
		assert.ok(d <= merged.radius + 1e-6, `child ${key} outside merged sphere (d=${d}, r=${merged.radius})`);
	}
});

test("bbox area", () => {
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const area = bboxAreaMeters(bbox);
	assert.ok(area > 500000 && area < 1500000);
});

test("ecef to wgs84 roundtrip sanity", () => {
	const wgs = ecefToWgs84(-2694046, -4298900, 3857879);
	assert.ok(Math.abs(wgs.lat - 37.42) < 0.5);
	assert.ok(Math.abs(wgs.lon + 122.08) < 0.5);
});

test("collect lod ancestor paths for backfill", () => {
	const { collectLodAncestorPaths } = require("../lib/osgb-lod-backfill");
	const paths = collectLodAncestorPaths(["3140504173706240404044"], 16);
	assert.strictEqual(paths.length, 6);
	assert.strictEqual(paths[0].length, 16);
	assert.strictEqual(paths[paths.length - 1].length, 21);
	assert.ok(paths.every((path, i) => i === 0 || path.length >= paths[i - 1].length));
});

test("resolve epsg auto follows projected engineering geojson crs", () => {
	const info = resolveEpsg("auto", 113.5, 22.5, {
		sourceCrs: "EPSG:4548",
	});
	assert.strictEqual(info.epsg, "EPSG:4548");
	assert.ok(info.description.includes("GeoJSON"));
});

test("resolve epsg auto falls back to utm for web mercator geojson", () => {
	const info = resolveEpsg("auto", 103.886, 1.309, {
		sourceCrs: "EPSG:3857",
	});
	assert.strictEqual(info.epsg, "EPSG:32648");
	assert.ok(/Web Mercator/i.test(info.description));
});

test("resolve epsg auto defaults to utm when geojson is wgs84", () => {
	const info = resolveEpsg("auto", 116.4, 39.9, { sourceCrs: "EPSG:4326" });
	assert.strictEqual(info.epsg, "EPSG:32650");
	assert.strictEqual(info.enu, false);
});

test("resolve epsg auto defaults to utm without geojson crs", () => {
	const info = resolveEpsg("auto", 116.4, 39.9);
	assert.strictEqual(info.epsg, "EPSG:32650");
	assert.strictEqual(info.enu, false);
});

test("build srs metadata from geojson 3857 uses utm projected srs origin", () => {
	const fs = require("fs");
	const path = require("path");
	const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/google_hq.geojson"), "utf8"));
	const bbox = getBboxFromGeoJSON(geo);
	const info = resolveEpsg("auto", (bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2, {
		sourceCrs: "EPSG:3857",
	});
	const srs = buildSrsMetadata(info, bbox);
	assert.strictEqual(srs.epsg, "EPSG:32648");
	// UTM 48N easting is ~370km, northing ~145km near the equator (Singapore).
	assert.ok(srs.srsOrigin[0] > 1e5 && srs.srsOrigin[0] < 1e6);
	assert.ok(srs.srsOrigin[1] > 1e5 && srs.srsOrigin[1] < 1e6);
});

test("osgb grid cell scales with export level (80m at L22)", () => {
	const { recommendOsgbGridCellSize, DASVIEWER_GRID_CELL_SIZE } = require("../lib/osgb-grid");
	assert.strictEqual(DASVIEWER_GRID_CELL_SIZE, 80);
	// L22 keeps the 80m DasViewer step; coarser levels scale up so the cell stays
	// >= the node footprint (avoids the checkerboard tiling seen at L18 with 80m).
	assert.strictEqual(recommendOsgbGridCellSize(22), 80);
	assert.strictEqual(recommendOsgbGridCellSize(20), 320);
	assert.strictEqual(recommendOsgbGridCellSize(18), 1280);
	// Clamped so very coarse levels don't explode.
	assert.ok(recommendOsgbGridCellSize(14) <= 2560);
	// Default (no level) stays at the L22 calibration.
	assert.strictEqual(recommendOsgbGridCellSize(), 80);
});

test("region-local vertices span negative offsets from srs origin", () => {
	const fs = require("fs");
	const path = require("path");
	const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/google_hq.geojson"), "utf8"));
	const bbox = getBboxFromGeoJSON(geo);
	const info = resolveEpsg("auto", (bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2, {
		sourceCrs: "EPSG:3857",
	});
	const transform = createCoordinateTransform(info, bbox);
	const ecef = require("../lib/coords").wgs84ToEcef(bbox.west, bbox.south, 0);
	const obj = transform.toExportVertex(transform.fromEcef(ecef.x, ecef.y, ecef.z));
	assert.ok(obj.x < -500, "bbox SW should be far negative in region-local X");
	assert.ok(-obj.z < -500, "bbox SW should be far negative in region-local Y");
});

test("region center uses global-local vertices when no tile origin", () => {
	const fs = require("fs");
	const path = require("path");
	const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/google_hq.geojson"), "utf8"));
	const bbox = getBboxFromGeoJSON(geo);
	const info = resolveEpsg("auto", (bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2, {
		sourceCrs: "EPSG:3857",
	});
	const transform = createCoordinateTransform(info, bbox);
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const ecef = require("../lib/coords").wgs84ToEcef(centerLon, centerLat, 0);
	const local = transform.fromEcef(ecef.x, ecef.y, ecef.z);
	const obj = transform.toExportVertex(local);
	assert.ok(Math.abs(obj.x) < 1, "region center should be near global-local X origin");
	assert.ok(Math.abs(obj.y) < 200, "height stays in local meters");
});

test("build srs metadata enu", () => {
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const info = resolveEpsg("enu", 0, 0);
	const srs = buildSrsMetadata(info, bbox);
	assert.ok(srs.epsg.startsWith("ENU:"));
	assert.ok(srs.epsg.includes(String((bbox.south + bbox.north) / 2)));
	assert.strictEqual(srs.srsOrigin[0], 0);
	assert.strictEqual(srs.srsOrigin[1], 0);
	assert.ok(Math.abs(srs.srsOrigin[2]) < 1e6);
});

test("osgb grid tile naming", () => {
	const {
		formatGridTileName,
		buildOsgbFileName,
		pathNameToGridTile,
	} = require("../lib/osgb-grid");
	assert.strictEqual(formatGridTileName(2, 3), "Tile_+002_+003");
	const fileName = buildOsgbFileName("Tile_+002_+003", "3140504173706240");
	assert.strictEqual(fileName, "Tile_+002_+003_L16_0.osgb");
	const tileName = pathNameToGridTile("3140504173706240404044", {
		epsgCode: "EPSG:32648",
		srsOrigin: [300000, 145000, 0],
		gridOrigin: { x: 300000, y: 145000 },
		gridCellSize: 500,
	});
	assert.match(tileName, /^Tile_\+\d{3}_\+\d{3}$/);
});

test("osgb grid anchors a whole subtree to one tile", () => {
	const fs = require("fs");
	const path = require("path");
	const {
		computeGridOrigin,
		recommendGridCellSize,
		pathNameToGridTile,
	} = require("../lib/osgb-grid");
	const { getBboxFromGeoJSON } = require("../lib/geojson-bbox");
	const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/google_hq.geojson"), "utf8"));
	const bbox = getBboxFromGeoJSON(geo);
	const srsOrigin = [11564566, 145754, 0];
	const gridOrigin = computeGridOrigin(bbox, "EPSG:3857", srsOrigin);
	const cellSize = recommendGridCellSize(bbox, "EPSG:3857");
	const gridOptions = {
		epsgCode: "EPSG:3857",
		srsOrigin,
		gridOrigin,
		gridCellSize: cellSize,
	};
	// p1, p2, p4 share the L16 prefix 3140504173706240; p3 is a different L16 octant.
	const p1 = "3140504173706240404044";
	const p2 = "3140504173706240504044";
	const p3 = "314050417361735062753";
	const p4 = "314050417370624062753";
	// Every node under one L16 anchor must land in the SAME tile folder, so the
	// subtree's parent->child PagedLOD references stay same-directory.
	const sameAnchor = new Set([p1, p2, p4].map((p) => pathNameToGridTile(p, gridOptions)));
	assert.strictEqual(sameAnchor.size, 1, "nodes sharing an L16 anchor must share a tile");
	// A different L16 anchor is free to occupy a different tile.
	const allTiles = new Set([p1, p2, p3, p4].map((p) => pathNameToGridTile(p, gridOptions)));
	assert.ok(allTiles.size >= 1 && allTiles.size <= 2, `expected <=2 tiles, got ${[...allTiles].join(", ")}`);
});

test("osgb grid tile naming with enu metadata", () => {
	const fs = require("fs");
	const path = require("path");
	const { pathNameToGridTile, getEnuTransformForGrid, computeGridOrigin } = require("../lib/osgb-grid");
	const { getBboxFromGeoJSON } = require("../lib/geojson-bbox");
	const geo = JSON.parse(fs.readFileSync(path.join(__dirname, "../examples/google_hq.geojson"), "utf8"));
	const bbox = getBboxFromGeoJSON(geo);
	const epsgCode = "ENU:1.3092189655180846,103.8862646551669";
	const enuTransform = getEnuTransformForGrid(epsgCode);
	const gridOrigin = computeGridOrigin(bbox, epsgCode, [0, 0, 0], enuTransform);
	const tileName = pathNameToGridTile("3140504173706240404044", {
		epsgCode,
		srsOrigin: [0, 0, 0],
		gridOrigin,
		gridCellSize: 500,
		enuTransform,
	});
	assert.match(tileName, /^Tile_\+\d{3}_\+\d{3}$/);
});

test("pick all exported children for paged lod", () => {
	const { pickExportedChildren } = require("../lib/osgb-paged-lod");
	const childMap = { abc: [0, 2, 5] };
	const exported = new Set(["abc0", "abc5"]);
	// Every exported child must be referenced, not just the first branch.
	assert.deepStrictEqual(pickExportedChildren("abc", childMap, exported), ["abc0", "abc5"]);
});

test("build child map from exported paths", () => {
	const { buildChildMapFromPaths } = require("../lib/osgb-index");
	const childMap = buildChildMapFromPaths(["abc0", "abc02", "abd"]);
	assert.deepStrictEqual(childMap.abc, ["0"]);
	assert.deepStrictEqual(childMap.abc0, ["2"]);
});

test("pick root child prefers finest exported node in tile", () => {
	const { pickRootChildForTile } = require("../lib/osgb-paged-lod");
	const root = "1234567890123456";
	const leaf = `${root}0123456789`;
	const childFile = pickRootChildForTile(
		[root, leaf],
		"Tile_+000_+000",
		new Set([leaf]),
		15,
	);
	assert.strictEqual(childFile, "Tile_+000_+000_L26_60123456789.osgb");
});

test("tile root references all region-root siblings in the grid tile", () => {
	const { pickRegionRootFilesForTile } = require("../lib/osgb-paged-lod");
	// Three sibling nodes whose shared parent is NOT exported -> all are region roots.
	const a = "1234567890123456701";
	const b = "1234567890123456702";
	const c = "1234567890123456703";
	const index = {
		nodes: {
			[a]: { gridTile: "Tile_+000_+000", osgbFile: "Tile_+000_+000_L19_a.osgb" },
			[b]: { gridTile: "Tile_+000_+000", osgbFile: "Tile_+000_+000_L19_b.osgb" },
			[c]: { gridTile: "Tile_+000_+000", osgbFile: "Tile_+000_+000_L19_c.osgb" },
		},
	};
	const files = pickRegionRootFilesForTile([a, b, c], index, new Set([a, b, c]));
	assert.strictEqual(files.length, 3, "all three region roots must be referenced");
	assert.deepStrictEqual(
		files.slice().sort(),
		["Tile_+000_+000_L19_a.osgb", "Tile_+000_+000_L19_b.osgb", "Tile_+000_+000_L19_c.osgb"],
	);
});

test("tile root references the coarse node, not its exported child", () => {
	const { pickRegionRootFilesForTile } = require("../lib/osgb-paged-lod");
	const parent = "12345678901234567";
	const child = `${parent}0`;
	const index = {
		nodes: {
			[parent]: { gridTile: "Tile_+000_+000", osgbFile: "parent.osgb" },
			[child]: { gridTile: "Tile_+000_+000", osgbFile: "child.osgb" },
		},
	};
	const files = pickRegionRootFilesForTile([parent, child], index, new Set([parent, child]));
	// Root pages in the coarsest node (parent); the child refines lazily under it.
	assert.deepStrictEqual(files, ["parent.osgb"], "only the region root (parent) is referenced");
});

test("paged lod node references every exported child", () => {
	const os = require("os");
	const fsx = require("fs");
	const { writePagedLodOsgt } = require("../lib/osgb-paged-lod");
	const out = path.join(os.tmpdir(), `ere-pagedlod-${process.pid}.osgt`);
	writePagedLodOsgt({
		outputPath: out,
		childFiles: ["c0.osgb", "c1.osgb", "c2.osgb"],
		geodeScene: "osg::Geode {\n}",
		center: { cx: 0, cy: 0, cz: 0, radius: 100 },
		rangeThreshold: 50,
	});
	const text = fsx.readFileSync(out, "utf8");
	fsx.unlinkSync(out);
	// 1 inline geode slot + 3 paged children = 4 slots.
	assert.match(text, /RangeList 4 \{/);
	assert.match(text, /RangeDataList 4 \{/);
	for (const f of ["c0.osgb", "c1.osgb", "c2.osgb"]) {
		assert.ok(text.includes(`"${f}"`), `child ${f} must be referenced`);
	}
	assert.ok(text.includes("PIXEL_SIZE_ON_SCREEN"));
	// DatabasePath MUST be FALSE: an explicit "./" makes DasViewer resolve child files
	// against its own working dir, so children never page in and LOD looks broken.
	assert.ok(text.includes("DatabasePath FALSE"), "DatabasePath must be FALSE for DasViewer paging");
	assert.ok(!text.includes('DatabasePath TRUE'), "must not pin DatabasePath");
});

test("subtree bounds enclose descendants", () => {
	const { computeSubtreeBounds } = require("../lib/osgb-paged-lod");
	const parent = "1234567890123456";
	const child = `${parent}0`;
	const index = {
		nodes: {
			[parent]: { bounds: { cx: 0, cy: 0, cz: 0, radius: 10 } },
			[child]: { bounds: { cx: 100, cy: 0, cz: 0, radius: 10 } },
		},
	};
	const childrenOf = { [parent]: [child], [child]: [] };
	const centers = computeSubtreeBounds([parent, child], index, childrenOf);
	// Parent sphere must reach past the child at x=110.
	assert.ok(centers[parent].cx + centers[parent].radius >= 110, "parent must enclose child");
});

test("lod tree links by nearest exported ancestor (sparse octree)", () => {
	const { buildLodTree } = require("../lib/osgb-paged-lod");
	// L16 anchor, no L17 exported, two L18 leaves -> leaves attach to the L16 node.
	const root = "3140504173617350";
	const leafA = `${root}04`;
	const leafB = `${root}05`;
	const { parentOf, childrenOf } = buildLodTree([root, leafA, leafB]);
	assert.strictEqual(parentOf[root], null, "L16 node is a region root");
	assert.strictEqual(parentOf[leafA], root, "leaf skips the missing L17 and attaches to L16");
	assert.deepStrictEqual(childrenOf[root].slice().sort(), [leafA, leafB]);
});

test("globe sphere conversion fixes vertical offset", () => {
	const { createEnuTransform, DEFAULT_GLOBE_RADIUS, ecefToWgs84 } = require("../lib/coords");
	const transform = createEnuTransform(103.8862646551669, 1.3092189655180846, 0, DEFAULT_GLOBE_RADIUS);
	const lat = 1.304 * Math.PI / 180;
	const lon = 103.877 * Math.PI / 180;
	const alt = 35;
	const r = DEFAULT_GLOBE_RADIUS + alt;
	const gx = r * Math.cos(lat) * Math.cos(lon);
	const gy = r * Math.cos(lat) * Math.sin(lon);
	const gz = r * Math.sin(lat);
	const brokenAlt = ecefToWgs84(gx, gy, gz).alt;
	const enu = transform.fromGlobe(gx, gy, gz);
	assert.ok(brokenAlt < -1000);
	assert.ok(Math.abs(enu.z) < 200);
});

test("enu transform export vertex remaps for osgconv", () => {
	const transform = createEnuTransform(103.886, 1.309, 0);
	const { wgs84ToEcef } = require("../lib/coords");
	const ecef = wgs84ToEcef(103.886, 1.309, 10);
	const enu = transform.fromEcef(ecef.x, ecef.y, ecef.z);
	const obj = transform.toExportVertex(enu);
	assert.deepStrictEqual(obj, { x: enu.x, y: enu.z, z: -enu.y });
});

test("enu transform localizes coordinates", () => {
	const { wgs84ToEcef } = require("../lib/coords");
	const transform = createEnuTransform(-122.084, 37.42, 0);
	const ecef = wgs84ToEcef(-122.084, 37.42, 50);
	const local = transform.fromEcef(ecef.x, ecef.y, ecef.z);
	assert.ok(Math.abs(local.x) < 1);
	assert.ok(Math.abs(local.y) < 1);
	assert.ok(Math.abs(local.z - 50) < 1);
});

test("coordinate transform projected mode", () => {
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const info = resolveEpsg("EPSG:4326", 0, 0);
	const transform = createCoordinateTransform(info, bbox);
	const local = transform.fromEcef(-2694046, -4298900, 3857879);
	assert.ok(Math.abs(local.x) < 1);
	assert.ok(Math.abs(local.y) < 1);
});

test("geojson 3857 reprojection", () => {
	const projector = require("proj4")("EPSG:4326", "EPSG:3857");
	const sw = projector.forward([-122.0895, 37.4185]);
	const ne = projector.forward([-122.0785, 37.4235]);
	const geojson3857 = {
		type: "FeatureCollection",
		crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
		features: [{
			type: "Feature",
			geometry: {
				type: "Polygon",
				coordinates: [[
					[sw[0], sw[1]],
					[ne[0], sw[1]],
					[ne[0], ne[1]],
					[sw[0], ne[1]],
					[sw[0], sw[1]],
				]],
			},
		}],
	};
	const normalized = normalizeGeoJSON(geojson3857);
	assert.strictEqual(normalized.reprojected, true);
	const bbox = getBboxFromGeoJSON(geojson3857);
	assert.ok(Math.abs(bbox.west + 122.0895) < 0.01);
	assert.ok(Math.abs(bbox.east + 122.0785) < 0.01);
	assert.ok(Math.abs(bbox.south - 37.4185) < 0.01);
	assert.ok(Math.abs(bbox.north - 37.4235) < 0.01);
});

test("octant start level for region bbox", () => {
	const { recommendOctantStartLevel } = require("../lib/level-recommend");
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const startLevel = recommendOctantStartLevel(bbox, 22);
	assert.ok(startLevel >= 2 && startLevel < 22);
});

test("path to box", () => {
	const { pathToBox, boxesIntersect, latLonToOctantPath } = require("../lib/octant-geo");
	const bbox = getBboxFromGeoJSON(sampleGeoJSON);
	const path = latLonToOctantPath((bbox.south + bbox.north) / 2, (bbox.west + bbox.east) / 2, 4);
	const box = pathToBox(path);
	assert.strictEqual(boxesIntersect(box, bbox), true);
});

test("async pool limits concurrency", async () => {
	const { createAsyncPool } = require("../lib/async-pool");
	let active = 0;
	let maxActive = 0;
	const pool = createAsyncPool(2);
	await pool.map([1, 2, 3, 4, 5], async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 20));
		active--;
	});
	assert.ok(maxActive <= 2);
});

test("progress tracker reconciles disk and progress file", async () => {
	const fs = require("fs-extra");
	const os = require("os");
	const path = require("path");
	const { createProgressTracker } = require("../lib/download-cache");

	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "region-progress-"));
	const outputDir = path.join(tmpRoot, "region");
	const tileDir = path.join(outputDir, "Data", "Tile_1234");
	await fs.ensureDir(tileDir);
	await fs.writeFile(path.join(tileDir, "Tile_1234.obj"), "mtllib Tile_1234.mtl\n");

	const progressFile = path.join(outputDir, ".region-progress.json");
	await fs.writeJson(progressFile, {
		completedNodes: ["1234", "9999"],
	});

	const tracker = createProgressTracker(progressFile, outputDir);
	const stats = await tracker.init();
	assert.strictEqual(stats.onDisk, 1);
	assert.strictEqual(stats.progressAfter, 1);
	assert.strictEqual(tracker.isExported("1234"), true);
	assert.strictEqual(tracker.isExported("9999"), false);
	await fs.remove(tmpRoot);
});

test("progress tracker keeps leaf progress in merged tile mode", async () => {
	const fs = require("fs-extra");
	const os = require("os");
	const path = require("path");
	const { createProgressTracker } = require("../lib/download-cache");

	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "region-progress-merged-"));
	const outputDir = path.join(tmpRoot, "region");
	const tileDir = path.join(outputDir, "Data", "Tile_314050417361716362");
	await fs.ensureDir(tileDir);
	await fs.writeFile(path.join(tileDir, "Tile_314050417361716362.obj"), "mtllib Tile_314050417361716362.mtl\n");

	const progressFile = path.join(outputDir, ".region-progress.json");
	await fs.writeJson(progressFile, {
		completedNodes: ["31405041736171636241", "31405041736171636242"],
	});

	const tracker = createProgressTracker(progressFile, outputDir, { tileGroupLevel: 18 });
	const stats = await tracker.init();
	assert.strictEqual(stats.onDisk, 1);
	assert.strictEqual(stats.progressAfter, 2);
	assert.strictEqual(tracker.isExported("31405041736171636241"), true);
	assert.strictEqual(tracker.isExported("31405041736171636299"), false);
	await fs.remove(tmpRoot);
});

test("exclude octants only when child node exists", () => {
	const { getExcludeOctants } = require("../lib/get-child-octants");
	const bulk = {
		childIndices: new Array(16).fill(-1),
		flags: [],
	};
	bulk.childIndices[8 * (0 + 1) + 2] = 1;
	bulk.childIndices[8 * (0 + 1) + 5] = 2;
	bulk.flags[1] = 12;
	bulk.flags[2] = 0;
	const api = {
		hasNodeAtIndex: (b, index) => !(b.flags[index] & 8),
		hasBulkMetadataAtIndex: (b, index) => !!(b.flags[index] & 4),
	};
	assert.deepStrictEqual(getExcludeOctants(bulk, 0, api), [5]);
});

test("async pool drain waits for dynamically queued tasks", async () => {
	const { createAsyncPool } = require("../lib/async-pool");
	const pool = createAsyncPool(2);
	let completed = 0;
	pool.run(async () => {
		await pool.run(async () => {
			completed++;
		});
	});
	await pool.drain();
	assert.strictEqual(completed, 1);
});

test("tile group key merges by prefix", () => {
	const { getTileGroupKey, recommendTileGroupLevel } = require("../lib/tile-group");
	const pathName = "314050417361735143";
	assert.strictEqual(getTileGroupKey(pathName, 14), pathName.substring(0, 14));
	assert.strictEqual(getTileGroupKey(pathName, 12), pathName.substring(0, 12));
	assert.strictEqual(getTileGroupKey(pathName, null), pathName);
	assert.strictEqual(recommendTileGroupLevel(22, { west: 0, east: 0.01, south: 0, north: 0.01 }), 18);
	assert.strictEqual(recommendTileGroupLevel(20, { west: 103.87, east: 103.90, south: 1.29, north: 1.32 }), 16);
});

test("tile group splits oversized buckets spatially", () => {
	const { getTileGroupKey, DEFAULT_MAX_NODES_PER_TILE } = require("../lib/tile-group");
	const groupCounts = new Map();
	const opts = { maxNodesPerTile: 2, groupCounts };
	assert.strictEqual(
		getTileGroupKey("3140504173706240601111", 18, opts),
		"314050417370624060",
	);
	assert.strictEqual(
		getTileGroupKey("3140504173706240602222", 18, opts),
		"314050417370624060",
	);
	assert.strictEqual(
		getTileGroupKey("3140504173706240603333", 18, opts),
		"3140504173706240603",
	);
	assert.strictEqual(DEFAULT_MAX_NODES_PER_TILE, 0);
});

test("obj merge writes valid triangle faces", () => {
	const { parseObj, mergeParsedObjs, buildObjText } = require("../lib/obj-merge");
	const sample = [
		"v 0 0 0\nv 1 0 0\nv 0 1 0\n",
		"vt 0 0\nvt 1 0\nvt 0 1\n",
		"vn 0 0 1\nvn 0 0 1\nvn 0 0 1\n",
		"usemtl tex_a\nf 1/1/1 2/2/2 3/3/3\n",
	].join("");
	const parsed = parseObj(sample);
	const merged = mergeParsedObjs([parsed], { tex_a: "tex_a.png" });
	const objText = buildObjText(merged, "Tile_test");
	assert.match(objText, /^f 1\/1\/1 2\/2\/2 3\/3\/3$/m);
	assert.strictEqual(parseObj(objText).faces.length, 1);
});

test("obj merge keeps all material textures", () => {
	const fs = require("fs-extra");
	const os = require("os");
	const path = require("path");
	const { mergeTileGroup } = require("../lib/obj-merge");

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-tex-"));
	const tileA = path.join(tmp, "Tile_a");
	const tileB = path.join(tmp, "Tile_b");
	fs.ensureDirSync(tileA);
	fs.ensureDirSync(tileB);
	fs.writeFileSync(path.join(tileA, "Tile_a.obj"), [
		"mtllib Tile_a.mtl",
		"usemtl tex_a",
		"v 0 0 0",
		"v 1 0 0",
		"v 0 1 0",
		"vt 0 0",
		"vt 1 0",
		"vt 0 1",
		"vn 0 0 1",
		"vn 0 0 1",
		"vn 0 0 1",
		"f 1/1/1 2/2/2 3/3/3",
	].join("\n"));
	fs.writeFileSync(path.join(tileA, "Tile_a.mtl"), "newmtl tex_a\nmap_Kd a.png\n");
	fs.writeFileSync(path.join(tileA, "a.png"), "a");
	fs.writeFileSync(path.join(tileB, "Tile_b.obj"), [
		"mtllib Tile_b.mtl",
		"usemtl tex_b",
		"v 2 0 0",
		"v 3 0 0",
		"v 2 1 0",
		"vt 0 0",
		"vt 1 0",
		"vt 0 1",
		"vn 0 0 1",
		"vn 0 0 1",
		"vn 0 0 1",
		"f 1/1/1 2/2/2 3/3/3",
	].join("\n"));
	fs.writeFileSync(path.join(tileB, "Tile_b.mtl"), "newmtl tex_b\nmap_Kd b.png\n");
	fs.writeFileSync(path.join(tileB, "b.png"), "b");

	return mergeTileGroup([tileA, tileB], path.join(tmp, "Tile_out"), "Tile_out").then(() => {
		const mtl = fs.readFileSync(path.join(tmp, "Tile_out", "Tile_out.mtl"), "utf8");
		assert.match(mtl, /map_Kd Tile_out_tex_a\.png/);
		assert.match(mtl, /map_Kd Tile_out_tex_b\.png/);
		fs.removeSync(tmp);
	});
});

runAllTests().catch((error) => {
	console.error(error);
	process.exit(1);
});
