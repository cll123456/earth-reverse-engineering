"use strict";

const proj4 = require("proj4");
const { pathToBox } = require("./octant-geo");
const { createEnuTransform, wgs84ToEcef, exportProjectedPoint } = require("./coords");

const DEFAULT_LOD_PREFIX_LEVEL = 15;
const DEFAULT_GRID_ANCHOR_LEVEL = 16;
/** Smart3D / DasViewer standard OSGB grid step at L22 (see Production_* reference tiles). */
const DASVIEWER_GRID_CELL_SIZE = 80;
/** Level the 80m cell is calibrated for; coarser levels scale the cell up. */
const GRID_CELL_ANCHOR_LEVEL = 22;
const MIN_GRID_CELL_SIZE = 40;
const MAX_GRID_CELL_SIZE = 2560;

function isEnuMetadata(epsgCode) {
	return typeof epsgCode === "string" && epsgCode.startsWith("ENU:");
}

function parseEnuMetadata(epsgCode) {
	const match = /^ENU:([^,]+),([^,]+)$/.exec(epsgCode);
	if (!match) {
		throw new Error(`Invalid ENU metadata SRS: ${epsgCode}`);
	}
	return { lat: parseFloat(match[1]), lon: parseFloat(match[2]) };
}

function getEnuTransformForGrid(epsgCode, globeRadius) {
	const { lat, lon } = parseEnuMetadata(epsgCode);
	return createEnuTransform(lon, lat, 0, globeRadius);
}

function wgs84ToGridXY(lon, lat, epsgCode, enuTransform = null) {
	if (isEnuMetadata(epsgCode)) {
		const enu = enuTransform || getEnuTransformForGrid(epsgCode);
		const ecef = wgs84ToEcef(lon, lat, 0);
		const local = enu.fromEcef(ecef.x, ecef.y, ecef.z);
		return { x: local.x, y: local.y };
	}
	if (enuTransform) {
		const point = exportProjectedPoint(lon, lat, epsgCode, enuTransform);
		return { x: point.x, y: point.y };
	}
	return wgs84ToProjected(lon, lat, epsgCode);
}

function recommendGridCellSizeFromSpan(width, height) {
	const longest = Math.max(width, height);
	if (longest <= 800) return 160;
	if (longest <= 2000) return 320;
	if (longest <= 5000) return 500;
	return 640;
}

function padGridIndex(value) {
	const n = Math.max(0, Math.floor(value));
	return String(n).padStart(3, "0");
}

function formatGridTileName(col, row) {
	return `Tile_+${padGridIndex(col)}_+${padGridIndex(row)}`;
}

function parseGridTileName(tileName) {
	const match = /^Tile_\+(\d{3})_\+(\d{3})$/.exec(tileName);
	if (!match) return null;
	return { col: parseInt(match[1], 10), row: parseInt(match[2], 10) };
}

function boxCenterWgs84(box) {
	return {
		lon: (box.w + box.e) / 2,
		lat: (box.n + box.s) / 2,
	};
}

function wgs84ToProjected(lon, lat, epsgCode) {
	const projector = proj4("EPSG:4326", epsgCode);
	const projected = projector.forward([lon, lat]);
	return { x: projected[0], y: projected[1] };
}

function computeGridOrigin(bbox, epsgCode, srsOrigin, enuTransform = null) {
	if (isEnuMetadata(epsgCode)) {
		const enu = enuTransform || getEnuTransformForGrid(epsgCode);
		const swEcef = wgs84ToEcef(bbox.west, bbox.south, 0);
		const sw = enu.fromEcef(swEcef.x, swEcef.y, swEcef.z);
		return {
			x: srsOrigin[0] || 0,
			y: srsOrigin[1] || 0,
			swX: sw.x,
			swY: sw.y,
			swZ: sw.z,
		};
	}
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const enu = enuTransform || createEnuTransform(centerLon, centerLat, 0);
	const sw = exportProjectedPoint(bbox.west, bbox.south, epsgCode, enu);
	return {
		x: srsOrigin[0],
		y: srsOrigin[1],
		swX: sw.x,
		swY: sw.y,
		swZ: sw.z,
	};
}

// A Google Earth node footprint roughly halves every level, so a fixed cell that
// fits L22 (~9.5m nodes) is far smaller than an L18 node (~153m). When the cell is
// smaller than the node spacing, leaves land in alternating cells and the tile grid
// becomes a checkerboard with gaps. Scale the cell with the level instead, anchored
// to the 80m DasViewer step at L22.
function recommendOsgbGridCellSize(maxLevel = GRID_CELL_ANCHOR_LEVEL) {
	const level = Number.isFinite(maxLevel) ? maxLevel : GRID_CELL_ANCHOR_LEVEL;
	const scale = 2 ** (GRID_CELL_ANCHOR_LEVEL - level);
	const cell = DASVIEWER_GRID_CELL_SIZE * scale;
	return Math.max(MIN_GRID_CELL_SIZE, Math.min(cell, MAX_GRID_CELL_SIZE));
}

function recommendGridCellSize(bbox, epsgCode, enuTransform = null) {
	if (isEnuMetadata(epsgCode)) {
		const enu = enuTransform || getEnuTransformForGrid(epsgCode);
		const swEcef = wgs84ToEcef(bbox.west, bbox.south, 0);
		const neEcef = wgs84ToEcef(bbox.east, bbox.north, 0);
		const sw = enu.fromEcef(swEcef.x, swEcef.y, swEcef.z);
		const ne = enu.fromEcef(neEcef.x, neEcef.y, neEcef.z);
		return recommendGridCellSizeFromSpan(Math.abs(ne.x - sw.x), Math.abs(ne.y - sw.y));
	}
	const projector = proj4("EPSG:4326", epsgCode);
	const sw = projector.forward([bbox.west, bbox.south]);
	const ne = projector.forward([bbox.east, bbox.north]);
	return recommendGridCellSizeFromSpan(Math.abs(ne[0] - sw[0]), Math.abs(ne[1] - sw[1]));
}

function computeTileCellOrigin(gridTileName, { gridOrigin, gridCellSize, srsOrigin }) {
	const parsed = parseGridTileName(gridTileName);
	if (!parsed) {
		throw new Error(`Invalid grid tile name: ${gridTileName}`);
	}
	const originX = (gridOrigin.swX ?? gridOrigin.x) + parsed.col * gridCellSize;
	const originY = (gridOrigin.swY ?? gridOrigin.y) + parsed.row * gridCellSize;
	return [originX, originY, gridOrigin.swZ ?? (srsOrigin[2] || 0)];
}

function pathNameToGridTile(pathName, { epsgCode, srsOrigin, gridOrigin, gridCellSize, enuTransform = null }) {
	// Use the node's own path center, not an L16 ancestor. All L22 leaves under one
	// L16 octant share the same L16 center (~600m box) and would pile into one tile.
	const center = boxCenterWgs84(pathToBox(pathName));
	const projected = wgs84ToGridXY(center.lon, center.lat, epsgCode, enuTransform);
	const originX = gridOrigin.swX ?? gridOrigin.x;
	const originY = gridOrigin.swY ?? gridOrigin.y;
	const col = Math.floor((projected.x - originX) / gridCellSize);
	const row = Math.floor((projected.y - originY) / gridCellSize);
	return formatGridTileName(col, row);
}

function buildOsgbFileName(gridTileName, pathName, lodPrefixLevel = DEFAULT_LOD_PREFIX_LEVEL) {
	const level = pathName.length;
	const suffix = pathName.substring(lodPrefixLevel);
	return `${gridTileName}_L${level}_${suffix}.osgb`;
}

function buildOsgbBaseName(gridTileName, pathName, lodPrefixLevel = DEFAULT_LOD_PREFIX_LEVEL) {
	return buildOsgbFileName(gridTileName, pathName, lodPrefixLevel).replace(/\.osgb$/, "");
}

function parentPathName(pathName) {
	return pathName.length > 2 ? pathName.substring(0, pathName.length - 1) : null;
}

function childPathNames(pathName, childOctants) {
	return childOctants.map((oct) => `${pathName}${oct}`);
}

function groupNodesByGridTile(pathNames, gridOptions) {
	const groups = new Map();
	for (const pathName of pathNames) {
		const tileName = pathNameToGridTile(pathName, gridOptions);
		if (!groups.has(tileName)) groups.set(tileName, []);
		groups.get(tileName).push(pathName);
	}
	for (const names of groups.values()) {
		names.sort();
	}
	return groups;
}

module.exports = {
	DEFAULT_LOD_PREFIX_LEVEL,
	DEFAULT_GRID_ANCHOR_LEVEL,
	DASVIEWER_GRID_CELL_SIZE,
	recommendOsgbGridCellSize,
	padGridIndex,
	formatGridTileName,
	parseGridTileName,
	isEnuMetadata,
	parseEnuMetadata,
	getEnuTransformForGrid,
	recommendGridCellSize,
	computeGridOrigin,
	computeTileCellOrigin,
	pathNameToGridTile,
	buildOsgbFileName,
	buildOsgbBaseName,
	parentPathName,
	childPathNames,
	groupNodesByGridTile,
	boxCenterWgs84,
};
