"use strict";

function buildChildMapFromPaths(exportedPaths) {
	const childMap = {};
	for (const pathName of exportedPaths) {
		if (pathName.length < 2) continue;
		const parent = pathName.slice(0, -1);
		const oct = pathName.slice(-1);
		if (!childMap[parent]) childMap[parent] = [];
		if (!childMap[parent].includes(oct)) childMap[parent].push(oct);
	}
	for (const key of Object.keys(childMap)) {
		childMap[key].sort();
	}
	return childMap;
}

function mergeChildMaps(existing = {}, derived = {}) {
	const merged = { ...existing };
	for (const [parent, octants] of Object.entries(derived)) {
		if (!merged[parent]) {
			merged[parent] = octants.slice();
			continue;
		}
		const set = new Set([...merged[parent], ...octants]);
		merged[parent] = [...set].sort();
	}
	return merged;
}

function registerPathInChildMap(childMap, pathName) {
	if (pathName.length < 2) return childMap;
	const parent = pathName.slice(0, -1);
	const oct = pathName.slice(-1);
	if (!childMap[parent]) childMap[parent] = [];
	if (!childMap[parent].includes(oct)) {
		childMap[parent].push(oct);
		childMap[parent].sort();
	}
	return childMap;
}

function ensureIndexChildMap(index) {
	const derived = buildChildMapFromPaths(Object.keys(index.nodes || {}));
	index.childMap = mergeChildMaps(index.childMap || {}, derived);
	return index;
}

module.exports = {
	buildChildMapFromPaths,
	mergeChildMaps,
	registerPathInChildMap,
	ensureIndexChildMap,
};
