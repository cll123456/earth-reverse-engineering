"use strict";

const { parseGeoJSON } = require("./geojson-bbox");
const { normalizeGeoJSON } = require("./geojson-normalize");

function getPolygonsFromGeoJSON(input) {
	const data = input && input._normalized ? input : normalizeGeoJSON(input).data;
	const parsed = parseGeoJSON(data);
	const polygons = [];

	function collectPolygons(geometry) {
		if (!geometry) return;
		if (geometry.type === "Polygon") {
			polygons.push(geometry.coordinates);
			return;
		}
		if (geometry.type === "MultiPolygon") {
			for (const polygon of geometry.coordinates) polygons.push(polygon);
		}
	}

	if (parsed.type === "FeatureCollection") {
		for (const feature of parsed.features || []) collectPolygons(feature.geometry);
	} else if (parsed.type === "Feature") {
		collectPolygons(parsed.geometry);
	} else {
		collectPolygons(parsed);
	}

	if (polygons.length === 0) {
		throw new Error("GeoJSON does not contain Polygon or MultiPolygon geometry");
	}
	return polygons;
}

function pointInRing(lon, lat, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersect = ((yi > lat) !== (yj > lat))
			&& (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

function pointInPolygon(lon, lat, polygon) {
	if (!pointInRing(lon, lat, polygon[0])) return false;
	for (let i = 1; i < polygon.length; i++) {
		if (pointInRing(lon, lat, polygon[i])) return false;
	}
	return true;
}

function pointInAnyPolygon(lon, lat, polygons) {
	return polygons.some((polygon) => pointInPolygon(lon, lat, polygon));
}

function createClipFilter(polygons, enabled) {
	if (!enabled || !polygons || polygons.length === 0) {
		return {
			enabled: false,
			keepTriangle() {
				return true;
			},
		};
	}

	return {
		enabled: true,
		keepTriangle(wgsA, wgsB, wgsC) {
			return pointInAnyPolygon(wgsA.lon, wgsA.lat, polygons)
				|| pointInAnyPolygon(wgsB.lon, wgsB.lat, polygons)
				|| pointInAnyPolygon(wgsC.lon, wgsC.lat, polygons);
		},
	};
}

module.exports = {
	getPolygonsFromGeoJSON,
	pointInPolygon,
	pointInAnyPolygon,
	createClipFilter,
};
