"use strict";

const { normalizeGeoJSON } = require("./geojson-normalize");

function walkCoordinates(coords, visit) {
	if (typeof coords[0] === "number") {
		visit(coords[0], coords[1]);
		return;
	}
	for (const part of coords) {
		walkCoordinates(part, visit);
	}
}

function extendBounds(bounds, lon, lat) {
	bounds.west = Math.min(bounds.west, lon);
	bounds.south = Math.min(bounds.south, lat);
	bounds.east = Math.max(bounds.east, lon);
	bounds.north = Math.max(bounds.north, lat);
}

function geometryToBbox(geometry) {
	if (!geometry || !geometry.coordinates) {
		throw new Error("GeoJSON geometry has no coordinates");
	}

	const bounds = {
		west: Infinity,
		south: Infinity,
		east: -Infinity,
		north: -Infinity,
	};

	walkCoordinates(geometry.coordinates, (lon, lat) => extendBounds(bounds, lon, lat));
	return bounds;
}

function parseGeoJSON(input) {
	const data = typeof input === "string" ? JSON.parse(input) : input;
	if (!data || !data.type) {
		throw new Error("Invalid GeoJSON: missing type");
	}
	return data;
}

function getBboxFromGeoJSON(input) {
	const data = input && input._normalized ? input : normalizeGeoJSON(input).data;

	if (data.type === "FeatureCollection") {
		if (!data.features || data.features.length === 0) {
			throw new Error("FeatureCollection has no features");
		}
		const bounds = {
			west: Infinity,
			south: Infinity,
			east: -Infinity,
			north: -Infinity,
		};
		for (const feature of data.features) {
			const featureBounds = geometryToBbox(feature.geometry);
			extendBounds(bounds, featureBounds.west, featureBounds.south);
			extendBounds(bounds, featureBounds.east, featureBounds.north);
		}
		return bounds;
	}

	if (data.type === "Feature") {
		return geometryToBbox(data.geometry);
	}

	return geometryToBbox(data);
}

module.exports = {
	parseGeoJSON,
	getBboxFromGeoJSON,
};
