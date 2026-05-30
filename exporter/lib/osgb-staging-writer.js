"use strict";

const fs = require("fs-extra");
const path = require("path");
const { createCoordinateTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createNodeWriter } = require("./mesh-writer");

function stagingNodeDir(stagingDir, pathName) {
	return path.join(stagingDir, "nodes", pathName);
}

function createOsgbStagingRegistry({
	outputDir,
	transformConfig,
	clipPolygons,
	clipEnabled,
}) {
	const stagingDir = path.join(outputDir, ".staging");
	const coordinateTransform = transformConfig
		? createCoordinateTransform(transformConfig.epsgInfo, transformConfig.bbox, transformConfig.globeRadius)
		: null;
	const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);
	const writers = new Map();
	const chains = new Map();
	const exportedPaths = new Set();
	const childMap = new Map();

	function runSerialized(pathName, fn) {
		const prev = chains.get(pathName) || Promise.resolve();
		const next = prev.then(() => fn(), () => fn());
		chains.set(pathName, next.catch(() => {}));
		return next;
	}

	async function writeNode({ pathName, node, exclude, childOctants = [] }) {
		if (childOctants.length > 0) {
			childMap.set(pathName, childOctants.slice().sort());
		}

		return runSerialized(pathName, async () => {
			const nodeDir = stagingNodeDir(stagingDir, pathName);
			const writer = createNodeWriter(nodeDir, pathName, coordinateTransform, clipFilter);
			writers.set(pathName, writer);
			const wroteAny = writer.writeNode(node, pathName, exclude);
			if (wroteAny) {
				exportedPaths.add(pathName);
			} else if (fs.existsSync(nodeDir)) {
				fs.removeSync(nodeDir);
			}
			return wroteAny;
		});
	}

	async function finalize() {
		await Promise.all([...chains.values()]);
		for (const [pathName, writer] of writers.entries()) {
			if (writer.removeIfEmpty()) {
				exportedPaths.delete(pathName);
			}
		}
		return {
			exportedCount: exportedPaths.size,
			exportedPaths: [...exportedPaths].sort(),
			childMap: Object.fromEntries(childMap.entries()),
		};
	}

	return {
		stagingDir,
		writeNode,
		finalize,
		get exportedCount() { return exportedPaths.size; },
	};
}

module.exports = {
	stagingNodeDir,
	createOsgbStagingRegistry,
};
