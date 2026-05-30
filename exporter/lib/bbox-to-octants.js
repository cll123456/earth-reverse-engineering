"use strict";

const { latLonToOctantPath, normalizeBbox } = require("./octant-geo");
const { resolveOnlineOctants } = require("./octant-online-search");
const { recommendOctantStartLevel } = require("./level-recommend");

module.exports = function init(utils) {
	return async function bboxToOctants(bbox, maxLevel, { verifyOnline = true } = {}) {
		if (!Number.isInteger(maxLevel) || maxLevel < 2 || maxLevel > 24) {
			throw new Error(`Invalid maxLevel: ${maxLevel}`);
		}

		const startLevel = recommendOctantStartLevel(normalizeBbox(bbox), maxLevel);
		if (verifyOnline) {
			return resolveOnlineOctants(bbox, startLevel, utils);
		}

		return collectCandidateOctants(bbox, startLevel);
	};
};

function collectCandidateOctants(bboxInput, startLevel) {
	const bbox = normalizeBbox(bboxInput);
	const results = new Set();
	const samplePoints = [
		[bbox.west, bbox.south],
		[bbox.east, bbox.south],
		[bbox.west, bbox.north],
		[bbox.east, bbox.north],
		[(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2],
	];

	const gridSize = 8;
	for (let i = 0; i <= gridSize; i++) {
		for (let j = 0; j <= gridSize; j++) {
			const lon = bbox.west + ((bbox.east - bbox.west) * i) / gridSize;
			const lat = bbox.south + ((bbox.north - bbox.south) * j) / gridSize;
			samplePoints.push([lon, lat]);
		}
	}

	for (const [lon, lat] of samplePoints) {
		results.add(latLonToOctantPath(lat, lon, startLevel));
	}

	return Array.from(results).sort();
}

module.exports.collectCandidateOctants = collectCandidateOctants;
