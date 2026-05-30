"use strict";

const proj4 = require("proj4");

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.006694379990141316;
const DEFAULT_GLOBE_RADIUS = 6371010.0;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function globeToEcef(x, y, z, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const scale = WGS84_A / globeRadius;
	return { x: x * scale, y: y * scale, z: z * scale };
}

function globeToGeodetic(x, y, z, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const ecef = globeToEcef(x, y, z, globeRadius);
	return ecefToWgs84(ecef.x, ecef.y, ecef.z);
}

function ecefToWgs84(x, y, z) {
	const b = WGS84_A * Math.sqrt(1 - WGS84_E2);
	const ep2 = (WGS84_A * WGS84_A - b * b) / (b * b);
	const p = Math.sqrt(x * x + y * y);
	const theta = Math.atan2(z * WGS84_A, p * b);
	const sinTheta = Math.sin(theta);
	const cosTheta = Math.cos(theta);
	const lat = Math.atan2(
		z + ep2 * b * sinTheta * sinTheta * sinTheta,
		p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta
	);
	const lon = Math.atan2(y, x);
	const sinLat = Math.sin(lat);
	const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
	const alt = p / Math.cos(lat) - N;
	return {
		lon: lon * RAD2DEG,
		lat: lat * RAD2DEG,
		alt,
	};
}

function wgs84ToEcef(lon, lat, alt = 0) {
	const lonRad = lon * DEG2RAD;
	const latRad = lat * DEG2RAD;
	const sinLat = Math.sin(latRad);
	const cosLat = Math.cos(latRad);
	const cosLon = Math.cos(lonRad);
	const sinLon = Math.sin(lonRad);
	const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
	const h = N + alt;
	return {
		x: h * cosLat * cosLon,
		y: h * cosLat * sinLon,
		z: h * sinLat,
	};
}

function recommendUtmEpsg(centerLon, centerLat) {
	const zone = Math.floor((centerLon + 180) / 6) + 1;
	const clampedZone = Math.min(60, Math.max(1, zone));
	if (centerLat >= 0) return `EPSG:${32600 + clampedZone}`;
	return `EPSG:${32700 + clampedZone}`;
}

// Web Mercator variants are conformal but NOT distance-preserving; using them as
// the OSGB engineering CRS makes DasViewer mis-scale/mis-place oblique tiles.
// Fall back to the local UTM zone (an equidistant transverse-Mercator) instead.
const NON_ENGINEERING_CRS = new Set(["EPSG:3857", "EPSG:900913", "EPSG:102100"]);

function isEngineeringCrs(crs) {
	if (!crs || crs === "EPSG:4326") return false;
	return !NON_ENGINEERING_CRS.has(crs.toUpperCase());
}

function recommendExportEpsg(centerLon, centerLat, sourceCrs) {
	if (isEngineeringCrs(sourceCrs)) {
		return sourceCrs;
	}
	return recommendUtmEpsg(centerLon, centerLat);
}

function resolveEpsg(epsgOption, centerLon, centerLat, options = {}) {
	if (!epsgOption || epsgOption === "auto") {
		const epsg = recommendExportEpsg(centerLon, centerLat, options.sourceCrs);
		let description;
		if (isEngineeringCrs(options.sourceCrs) && epsg === options.sourceCrs) {
			description = `${epsg} (from GeoJSON CRS)`;
		} else if (options.sourceCrs && NON_ENGINEERING_CRS.has(options.sourceCrs.toUpperCase())) {
			description = `${epsg} (auto UTM; GeoJSON CRS ${options.sourceCrs} is Web Mercator, not suitable for oblique meshes)`;
		} else {
			description = `${epsg} (auto UTM from region center; GeoJSON had no projected CRS)`;
		}
		return {
			epsg,
			description,
			sourceCrs: options.sourceCrs || "EPSG:4326",
			enu: false,
		};
	}
	if (epsgOption === "enu") {
		return {
			epsg: "ENU",
			description: `ENU local tangent plane at ${centerLon.toFixed(6)}, ${centerLat.toFixed(6)}`,
			sourceCrs: options.sourceCrs || "EPSG:4326",
			enu: true,
		};
	}
	if (/^EPSG:\d+$/i.test(epsgOption)) {
		return {
			epsg: epsgOption.toUpperCase(),
			description: epsgOption,
			sourceCrs: options.sourceCrs || "EPSG:4326",
			enu: false,
		};
	}
	if (/^\d+$/.test(epsgOption)) {
		return {
			epsg: `EPSG:${epsgOption}`,
			description: `EPSG:${epsgOption}`,
			sourceCrs: options.sourceCrs || "EPSG:4326",
			enu: false,
		};
	}
	throw new Error(`Invalid EPSG value: ${epsgOption}`);
}

function normalizeVector(v) {
	const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
	if (len <= 1e-12) return { x: 0, y: 1, z: 0 };
	return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// ENU (X=east, Y=north, Z=up) -> OBJ for iFreedo osgconv, which maps (x, -z, y) -> OSGB Z-up.
function enuToObjVertex(e, n, u) {
	return { x: e, y: u, z: -n };
}

function enuToObjNormal(e, n, u) {
	return normalizeVector({ x: e, y: u, z: -n });
}

function attachExportMapping(transform) {
	transform.toExportVertex = (point) => enuToObjVertex(point.x, point.y, point.z);
	transform.toExportNormal = (normal) => enuToObjNormal(normal.x, normal.y, normal.z);
	return transform;
}

function createEnuTransform(originLon, originLat, originAlt = 0, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const origin = wgs84ToEcef(originLon, originLat, originAlt);
	const lonRad = originLon * DEG2RAD;
	const latRad = originLat * DEG2RAD;
	const sinLon = Math.sin(lonRad);
	const cosLon = Math.cos(lonRad);
	const sinLat = Math.sin(latRad);
	const cosLat = Math.cos(latRad);

	function fromEcef(x, y, z) {
		const dx = x - origin.x;
		const dy = y - origin.y;
		const dz = z - origin.z;
		return {
			x: -sinLon * dx + cosLon * dy,
			y: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
			z: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
		};
	}

	function fromGlobe(x, y, z) {
		const ecef = globeToEcef(x, y, z, globeRadius);
		return fromEcef(ecef.x, ecef.y, ecef.z);
	}

	function globeToWgs84(x, y, z) {
		return globeToGeodetic(x, y, z, globeRadius);
	}

	function transformNormal(nx, ny, nz) {
		return {
			x: -sinLon * nx + cosLon * ny,
			y: -sinLat * cosLon * nx - sinLat * sinLon * ny + cosLat * nz,
			z: cosLat * cosLon * nx + cosLat * sinLon * ny + sinLat * nz,
		};
	}

	return attachExportMapping({
		epsgCode: "ENU",
		srsOrigin: [0, 0, 0],
		enuOrigin: { lon: originLon, lat: originLat, alt: originAlt },
		globeRadius,
		fromGlobe,
		fromEcef,
		globeToWgs84,
		transformNormal,
	});
}

function createProjectedTransform(epsgCode, srsOrigin, enuTransform, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const projector = proj4("EPSG:4326", epsgCode);
	return attachExportMapping({
		epsgCode,
		srsOrigin,
		enuOrigin: null,
		globeRadius,
		fromGlobe(x, y, z) {
			const localEnu = enuTransform.fromGlobe(x, y, z);
			const wgs = enuTransform.globeToWgs84(x, y, z);
			const projected = projector.forward([wgs.lon, wgs.lat]);
			return {
				x: projected[0] - srsOrigin[0],
				y: projected[1] - srsOrigin[1],
				z: localEnu.z - srsOrigin[2],
				wgs,
			};
		},
		fromEcef(x, y, z) {
			const localEnu = enuTransform.fromEcef(x, y, z);
			const wgs = ecefToWgs84(x, y, z);
			const projected = projector.forward([wgs.lon, wgs.lat]);
			return {
				x: projected[0] - srsOrigin[0],
				y: projected[1] - srsOrigin[1],
				z: localEnu.z - srsOrigin[2],
				wgs,
			};
		},
		globeToWgs84(x, y, z) {
			return globeToGeodetic(x, y, z, globeRadius);
		},
		transformNormal(nx, ny, nz) {
			return enuTransform.transformNormal(nx, ny, nz);
		},
	});
}

function createEnuTileTransform(enuTransform, tileOrigin) {
	const ox = tileOrigin[0];
	const oy = tileOrigin[1];
	const oz = tileOrigin[2] || 0;
	return attachExportMapping({
		epsgCode: "ENU",
		srsOrigin: tileOrigin,
		enuOrigin: enuTransform.enuOrigin,
		globeRadius: enuTransform.globeRadius,
		fromGlobe(x, y, z) {
			const local = enuTransform.fromGlobe(x, y, z);
			const wgs = enuTransform.globeToWgs84(x, y, z);
			return {
				x: local.x - ox,
				y: local.y - oy,
				z: local.z - oz,
				wgs,
			};
		},
		fromEcef(x, y, z) {
			const local = enuTransform.fromEcef(x, y, z);
			const wgs = ecefToWgs84(x, y, z);
			return {
				x: local.x - ox,
				y: local.y - oy,
				z: local.z - oz,
				wgs,
			};
		},
		globeToWgs84(x, y, z) {
			return enuTransform.globeToWgs84(x, y, z);
		},
		transformNormal(nx, ny, nz) {
			return enuTransform.transformNormal(nx, ny, nz);
		},
	});
}

function createTileCoordinateTransform(epsgInfo, bbox, tileOrigin, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const enu = createEnuTransform(centerLon, centerLat, 0, globeRadius);

	if (epsgInfo.enu) {
		return createEnuTileTransform(enu, tileOrigin);
	}

	const transform = createProjectedTransform(epsgInfo.epsg, tileOrigin, enu, globeRadius);
	transform.enuOrigin = null;
	return transform;
}

function createCoordinateTransform(epsgInfo, bbox, globeRadius = DEFAULT_GLOBE_RADIUS) {
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const enu = createEnuTransform(centerLon, centerLat, 0, globeRadius);

	if (epsgInfo.enu) {
		return enu;
	}

	const srs = computeProjectedSrsOrigin(bbox, epsgInfo.epsg, enu);
	const transform = createProjectedTransform(epsgInfo.epsg, srs.srsOrigin, enu, globeRadius);
	transform.enuOrigin = null;
	return transform;
}

function exportProjectedPoint(lon, lat, epsgCode, enuTransform) {
	const ecef = wgs84ToEcef(lon, lat, 0);
	const wgs = ecefToWgs84(ecef.x, ecef.y, ecef.z);
	const projector = proj4("EPSG:4326", epsgCode);
	const projected = projector.forward([wgs.lon, wgs.lat]);
	const z = enuTransform.fromEcef(ecef.x, ecef.y, ecef.z).z;
	return { x: projected[0], y: projected[1], z };
}

function computeProjectedSrsOrigin(bbox, epsgCode, enuTransform = null) {
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;
	const enu = enuTransform || createEnuTransform(centerLon, centerLat, 0);
	const center = exportProjectedPoint(centerLon, centerLat, epsgCode, enu);
	return {
		srsOrigin: [center.x, center.y, center.z],
		center: { lon: centerLon, lat: centerLat },
	};
}

function buildSrsMetadata(epsgInfo, bbox, coordinateTransform) {
	const centerLon = (bbox.west + bbox.east) / 2;
	const centerLat = (bbox.south + bbox.north) / 2;

	if (epsgInfo.enu) {
		const enu = createEnuTransform(centerLon, centerLat, 0);
		const centerEcef = wgs84ToEcef(centerLon, centerLat, 0);
		const originZ = enu.fromEcef(centerEcef.x, centerEcef.y, centerEcef.z).z;
		return {
			epsg: `ENU:${centerLat},${centerLon}`,
			srsOrigin: [0, 0, originZ],
			center: { lon: centerLon, lat: centerLat },
			description: epsgInfo.description,
		};
	}

	const enu = createEnuTransform(centerLon, centerLat, 0);
	const projected = computeProjectedSrsOrigin(bbox, epsgInfo.epsg, enu);
	return {
		epsg: epsgInfo.epsg,
		srsOrigin: projected.srsOrigin,
		center: projected.center,
		description: epsgInfo.description,
	};
}

module.exports = {
	ecefToWgs84,
	wgs84ToEcef,
	globeToEcef,
	globeToGeodetic,
	DEFAULT_GLOBE_RADIUS,
	resolveEpsg,
	recommendUtmEpsg,
	recommendExportEpsg,
	isEngineeringCrs,
	createCoordinateTransform,
	createTileCoordinateTransform,
	createEnuTransform,
	buildSrsMetadata,
	computeProjectedSrsOrigin,
	exportProjectedPoint,
	enuToExportVertex: enuToObjVertex,
	enuToExportNormal: enuToObjNormal,
	enuToObjVertex,
	enuToObjNormal,
};
