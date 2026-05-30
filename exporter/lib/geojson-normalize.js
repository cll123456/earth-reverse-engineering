"use strict";

const proj4 = require("proj4");

const CRS_PATTERNS = [
	{ pattern: /EPSG::3857|EPSG:3857|900913|102100/i, epsg: "EPSG:3857" },
	{ pattern: /EPSG::4490|EPSG:4490/i, epsg: "EPSG:4490" },
	{ pattern: /EPSG::4326|EPSG:4326/i, epsg: "EPSG:4326" },
	{ pattern: /CRS84/i, epsg: "EPSG:4326" },
];

function detectCrsFromGeoJSON(data) {
	if (data.crs && data.crs.properties && data.crs.properties.name) {
		const name = data.crs.properties.name;
		for (const entry of CRS_PATTERNS) {
			if (entry.pattern.test(name)) return entry.epsg;
		}
	}
	return null;
}

function sampleCoordinate(geometry) {
	let sample = null;
	walkCoordinates(geometry.coordinates, (x, y) => {
		if (!sample) sample = { x, y };
	});
	return sample;
}

function walkCoordinates(coords, visit) {
	if (typeof coords[0] === "number") {
		visit(coords[0], coords[1]);
		return;
	}
	for (const part of coords) walkCoordinates(part, visit);
}

function mapCoordinates(coords, mapper) {
	if (typeof coords[0] === "number") {
		const mapped = mapper(coords[0], coords[1]);
		return [mapped[0], mapped[1], ...coords.slice(2)];
	}
	return coords.map((part) => mapCoordinates(part, mapper));
}

function inferCrsFromCoordinates(data) {
	let maxAbs = 0;
	function inspectGeometry(geometry) {
		if (!geometry) return;
		walkCoordinates(geometry.coordinates, (x, y) => {
			maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
		});
	}

	if (data.type === "FeatureCollection") {
		for (const feature of data.features || []) inspectGeometry(feature.geometry);
	} else if (data.type === "Feature") {
		inspectGeometry(data.geometry);
	} else {
		inspectGeometry(data);
	}

	if (maxAbs > 1000) return "EPSG:3857";
	if (maxAbs <= 180) return "EPSG:4326";
	return "EPSG:4326";
}

function reprojectGeometry(geometry, sourceCrs) {
	if (!geometry || !geometry.coordinates || sourceCrs === "EPSG:4326") return geometry;
	const projector = proj4(sourceCrs, "EPSG:4326");
	return {
		...geometry,
		coordinates: mapCoordinates(geometry.coordinates, (x, y) => projector.forward([x, y])),
	};
}

function normalizeGeoJSON(input) {
	const raw = typeof input === "string" ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
	const declaredCrs = detectCrsFromGeoJSON(raw);
	const sourceCrs = declaredCrs || inferCrsFromCoordinates(raw);

	const normalized = {
		type: raw.type,
		features: undefined,
		geometry: undefined,
		properties: raw.properties,
	};

	if (raw.type === "FeatureCollection") {
		normalized.features = (raw.features || []).map((feature) => ({
			...feature,
			geometry: reprojectGeometry(feature.geometry, sourceCrs),
		}));
	} else if (raw.type === "Feature") {
		normalized.type = "FeatureCollection";
		normalized.features = [{
			...raw,
			geometry: reprojectGeometry(raw.geometry, sourceCrs),
		}];
	} else {
		normalized.type = "FeatureCollection";
		normalized.features = [{
			type: "Feature",
			properties: {},
			geometry: reprojectGeometry(raw, sourceCrs),
		}];
	}

	normalized._normalized = true;

	return {
		data: normalized,
		sourceCrs,
		normalizedCrs: "EPSG:4326",
		reprojected: sourceCrs !== "EPSG:4326",
	};
}

module.exports = {
	normalizeGeoJSON,
	detectCrsFromGeoJSON,
	inferCrsFromCoordinates,
};
