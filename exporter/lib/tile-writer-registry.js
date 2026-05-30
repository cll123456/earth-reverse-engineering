"use strict";

const path = require("path");
const { createCoordinateTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createTileWriter } = require("./mesh-writer");
const { getTileGroupKey, DEFAULT_MAX_NODES_PER_TILE } = require("./tile-group");

function createTileWriterRegistry({
	outputDir,
	transformConfig,
	clipPolygons,
	clipEnabled,
	tileGroupLevel,
	maxNodesPerTile = DEFAULT_MAX_NODES_PER_TILE,
}) {
	const coordinateTransform = transformConfig
		? createCoordinateTransform(transformConfig.epsgInfo, transformConfig.bbox, transformConfig.globeRadius)
		: null;
	const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);
	const writers = new Map();
	const chains = new Map();
	const groupCounts = new Map();
	let mergedTileCount = 0;

	function runSerialized(tileName, fn) {
		const prev = chains.get(tileName) || Promise.resolve();
		const next = prev.then(() => fn(), () => fn());
		chains.set(tileName, next.catch(() => {}));
		return next;
	}

	async function writeNode({ pathName, node, exclude }) {
		const groupKey = getTileGroupKey(pathName, tileGroupLevel, {
			maxNodesPerTile: tileGroupLevel ? maxNodesPerTile : 0,
			groupCounts,
		});
		const tileName = `Tile_${groupKey}`;
		const tileDir = path.join(outputDir, "Data", tileName);

		return runSerialized(tileName, async () => {
			if (!writers.has(tileName)) {
				writers.set(tileName, createTileWriter(tileDir, tileName, coordinateTransform, clipFilter));
				mergedTileCount++;
			}
			const writer = writers.get(tileName);
			return writer.writeNode(node, pathName, exclude);
		});
	}

	async function finalize() {
		await Promise.all([...chains.values()]);
		for (const [tileName, writer] of writers.entries()) {
			if (writer.removeIfEmpty()) {
				writers.delete(tileName);
			}
		}
		return {
			mergedTileCount: writers.size,
			registeredGroups: mergedTileCount,
		};
	}

	return {
		writeNode,
		finalize,
		get mergedTileCount() { return writers.size; },
	};
}

module.exports = {
	createTileWriterRegistry,
};
