"use strict";

const EARTH_RADIUS_M = 6378137;
const MIN_LEVEL = 2;
const MAX_LEVEL = 24;

function bboxAreaMeters(bbox) {
	const latMid = (bbox.south + bbox.north) / 2;
	const width = (bbox.east - bbox.west) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(latMid * Math.PI / 180);
	const height = (bbox.north - bbox.south) * Math.PI / 180 * EARTH_RADIUS_M;
	return Math.abs(width * height);
}

function parseMaxLevel(requestedLevel) {
	if (requestedLevel === undefined || requestedLevel === null || requestedLevel === "auto") {
		return null;
	}
	const level = parseInt(requestedLevel, 10);
	if (!/^\d{1,2}$/.test(String(requestedLevel)) || Number.isNaN(level)) {
		throw new Error(`Invalid max_level: ${requestedLevel}`);
	}
	if (level < MIN_LEVEL || level > MAX_LEVEL) {
		throw new Error(`max_level must be between ${MIN_LEVEL} and ${MAX_LEVEL}, got ${level}`);
	}
	return level;
}

function recommendMaxLevel(bbox, requestedLevel) {
	const explicit = parseMaxLevel(requestedLevel);
	if (explicit !== null) return explicit;

	const area = bboxAreaMeters(bbox);
	if (area <= 5_000) return 22;
	if (area <= 20_000) return 21;
	if (area <= 80_000) return 20;
	if (area <= 320_000) return 19;
	if (area <= 1_280_000) return 18;
	if (area <= 5_000_000) return 17;
	if (area <= 20_000_000) return 16;
	return 15;
}

function recommendOctantStartLevel(bbox, maxLevel) {
	const latMid = (bbox.south + bbox.north) / 2;
	const widthM = Math.abs(bbox.east - bbox.west) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(latMid * Math.PI / 180);
	const heightM = Math.abs(bbox.north - bbox.south) * Math.PI / 180 * EARTH_RADIUS_M;
	const spanM = Math.max(widthM, heightM, 100);
	const earthCircumference = 2 * Math.PI * EARTH_RADIUS_M;
	let level = 2;
	let cell = earthCircumference / 8;
	while (level < maxLevel - 2 && cell > spanM / 3) {
		level += 1;
		cell /= 2;
	}
	return level;
}

module.exports = {
	MIN_LEVEL,
	MAX_LEVEL,
	bboxAreaMeters,
	parseMaxLevel,
	recommendMaxLevel,
	recommendOctantStartLevel,
};
