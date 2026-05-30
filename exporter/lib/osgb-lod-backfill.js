"use strict";

const { DEFAULT_GRID_ANCHOR_LEVEL } = require("./osgb-grid");

function collectLodAncestorPaths(exportedPaths, minLevel = DEFAULT_GRID_ANCHOR_LEVEL) {
	const exportedSet = new Set(exportedPaths);
	const backfill = new Set();
	for (const pathName of exportedPaths) {
		for (let len = pathName.length - 1; len >= minLevel; len--) {
			const ancestor = pathName.substring(0, len);
			if (!exportedSet.has(ancestor)) {
				backfill.add(ancestor);
			}
		}
	}
	return [...backfill].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

module.exports = {
	collectLodAncestorPaths,
};
