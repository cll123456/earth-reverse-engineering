"use strict";

const { getFirstOctant, getNextOctant, normalizeBbox } = require("./octant-geo");

function createCheckNodePath({ getPlanetoid, getBulk, bulk: { getIndexByPath, hasBulkMetadataAtIndex } }) {
	return async function checkNodePath(nodePath) {
		try {
			const planetoid = await getPlanetoid();
			const rootEpoch = planetoid.bulkMetadataEpoch[0];
			let bulk = null;
			let index = -1;

			for (let epoch = rootEpoch, i = 4; i < nodePath.length + 4; i += 4) {
				const bulkPath = nodePath.substring(0, i - 4);
				const subPath = nodePath.substring(0, i);

				if (bulk) {
					const idx = getIndexByPath(bulk, bulkPath);
					if (hasBulkMetadataAtIndex(bulk, idx)) return false;
				}

				bulk = await getBulk(bulkPath, epoch);
				index = getIndexByPath(bulk, subPath);
				if (index < 0) return false;
				epoch = bulk.bulkMetadataEpoch[index];
			}
			return index >= 0;
		} catch (error) {
			if (isNotFoundError(error)) return false;
			throw error;
		}
	};
}

function isNotFoundError(error) {
	const message = error && error.message ? error.message : String(error);
	return /HTTP status code 404/.test(message);
}

function buildSamplePoints(bboxInput) {
	const bbox = normalizeBbox(bboxInput);
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
	return samplePoints;
}

async function searchPointOctants(lat, lon, maxLevel, checkNodePath) {
	const results = new Set();

	async function search(nodePath, box) {
		if (nodePath.length > maxLevel) return;
		if (!(await checkNodePath(nodePath))) return;

		if (nodePath.length === maxLevel) {
			results.add(nodePath);
			return;
		}

		const [nextKey, nextBox] = getNextOctant(box, lat, lon);
		await search(nodePath + String(nextKey), nextBox);
		await search(nodePath + String(nextKey + 4), nextBox);
	}

	const [nodePath, box] = getFirstOctant(lat, lon);
	await search(nodePath, box);
	return results;
}

async function resolveOnlineOctants(bbox, startLevel, utils) {
	const checkNodePath = createCheckNodePath(utils);
	const results = new Set();
	const samplePoints = buildSamplePoints(bbox);

	for (const [lon, lat] of samplePoints) {
		const paths = await searchPointOctants(lat, lon, startLevel, checkNodePath);
		for (const path of paths) results.add(path);
	}

	return Array.from(results).sort();
}

module.exports = {
	createCheckNodePath,
	buildSamplePoints,
	searchPointOctants,
	resolveOnlineOctants,
	isNotFoundError,
};
