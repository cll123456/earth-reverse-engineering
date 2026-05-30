"use strict";

const { bboxAreaMeters } = require("./level-recommend");

// 0 = disabled; when set, overflow splits by next octant digit (spatial), not export order
const DEFAULT_MAX_NODES_PER_TILE = 0;

function getTileGroupKey(pathName, tileGroupLevel, options = {}) {
	const { maxNodesPerTile = 0, groupCounts = null } = options;

	if (!tileGroupLevel || tileGroupLevel <= 0) {
		return pathName;
	}

	const baseKey = pathName.length <= tileGroupLevel
		? pathName
		: pathName.substring(0, tileGroupLevel);

	if (!maxNodesPerTile || !groupCounts) {
		return baseKey;
	}

	let key = baseKey;
	let splitLevel = tileGroupLevel;

	while (true) {
		const count = groupCounts.get(key) || 0;
		if (count < maxNodesPerTile) {
			groupCounts.set(key, count + 1);
			return key;
		}
		if (pathName.length <= splitLevel) {
			const overflow = `${key}o${Math.floor(count / maxNodesPerTile)}`;
			groupCounts.set(overflow, (groupCounts.get(overflow) || 0) + 1);
			return overflow;
		}
		splitLevel += 1;
		key = pathName.substring(0, splitLevel);
	}
}

function parseTileGroupLevel(raw, maxLevel, bbox = null) {
	if (raw === undefined || raw === null || raw === "auto") {
		return recommendTileGroupLevel(maxLevel, bbox);
	}
	const level = parseInt(raw, 10);
	if (!/^\d{1,2}$/.test(String(raw)) || Number.isNaN(level)) {
		throw new Error(`Invalid tile group level: ${raw}`);
	}
	if (level < 4 || level > maxLevel) {
		throw new Error(`tile group level must be between 4 and max_level (${maxLevel}), got ${level}`);
	}
	return level;
}

function recommendTileGroupLevel(maxLevel, bbox) {
	// L18 (~160m): ~100 blocks/region; same octant prefix keeps ground + roofs together
	let groupLevel = maxLevel >= 20 ? Math.min(18, maxLevel - 4) : Math.max(10, maxLevel - 2);
	if (bbox) {
		const area = bboxAreaMeters(bbox);
		if (area > 20_000_000) groupLevel = Math.min(groupLevel, 16);
	}
	return Math.max(10, Math.min(groupLevel, maxLevel));
}

function approximateBlockSizeMeters(level) {
	const earthCircumference = 2 * Math.PI * 6378137;
	return earthCircumference / (2 ** level);
}

module.exports = {
	getTileGroupKey,
	parseTileGroupLevel,
	recommendTileGroupLevel,
	approximateBlockSizeMeters,
	DEFAULT_MAX_NODES_PER_TILE,
};
