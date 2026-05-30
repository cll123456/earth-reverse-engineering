"use strict";

const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createCoordinateTransform, createEnuTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createNodeWriter } = require("./mesh-writer");
const { createOsgbConvertPool } = require("./osgb-convert-pool");
const {
	buildOsgbFileName,
	pathNameToGridTile,
	recommendOsgbGridCellSize,
	computeGridOrigin,
	isEnuMetadata,
	getEnuTransformForGrid,
} = require("./osgb-grid");
const { readObjBounds } = require("./osgb-paged-lod");
const { registerPathInChildMap, ensureIndexChildMap } = require("./osgb-index");

function indexPath(outputDir) {
	return path.join(outputDir, ".region-osgb-index.json");
}

async function loadIndex(outputDir) {
	const file = indexPath(outputDir);
	if (await fs.pathExists(file)) {
		return fs.readJson(file);
	}
	return { nodes: {}, childMap: {} };
}

function createOsgbStreamRegistry({
	outputDir,
	transformConfig,
	clipPolygons,
	clipEnabled,
	bbox,
	epsgCode,
	srsOrigin,
	maxLevel,
	convertWorkers = 4,
	maxConvertQueue = null,
}) {
	const coordinateTransform = transformConfig
		? createCoordinateTransform(transformConfig.epsgInfo, transformConfig.bbox, transformConfig.globeRadius)
		: null;
	const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);
	const convertPool = createOsgbConvertPool({ concurrency: convertWorkers });
	const convertQueueCap = maxConvertQueue || Math.max(convertWorkers * 6, 12);
	const globeRadius = transformConfig?.globeRadius;
	const regionEnuTransform = bbox && transformConfig
		? createEnuTransform(
			(bbox.west + bbox.east) / 2,
			(bbox.south + bbox.north) / 2,
			0,
			globeRadius,
		)
		: null;
	const enuTransform = isEnuMetadata(epsgCode)
		? getEnuTransformForGrid(epsgCode, globeRadius)
		: regionEnuTransform;
	const cellSize = recommendOsgbGridCellSize(maxLevel);
	const gridOrigin = computeGridOrigin(bbox, epsgCode, srsOrigin, enuTransform);
	const gridOptions = { epsgCode, srsOrigin, gridOrigin, gridCellSize: cellSize, enuTransform };

	const index = { nodes: {}, childMap: {} };
	let indexLoaded = false;
	let indexDirty = false;
	let indexTimer = null;
	const exportedPaths = new Set();
	const convertErrors = [];
	let convertSubmitted = 0;

	async function ensureIndexLoaded() {
		if (indexLoaded) return;
		const saved = await loadIndex(outputDir);
		Object.assign(index.nodes, saved.nodes || {});
		Object.assign(index.childMap, saved.childMap || {});
		for (const pathName of Object.keys(index.nodes)) {
			exportedPaths.add(pathName);
		}
		ensureIndexChildMap(index);
		indexLoaded = true;
	}

	async function saveIndex() {
		ensureIndexChildMap(index);
		await fs.ensureDir(outputDir);
		await fs.writeJson(indexPath(outputDir), index, { spaces: 2 });
		indexDirty = false;
	}

	function scheduleIndexSave() {
		indexDirty = true;
		if (!indexTimer) {
			indexTimer = setTimeout(async () => {
				indexTimer = null;
				if (indexDirty) await saveIndex();
			}, 2000);
		}
	}

	function recordExportedNode(pathName, indexEntry) {
		index.nodes[pathName] = indexEntry;
		exportedPaths.add(pathName);
		registerPathInChildMap(index.childMap, pathName);
		scheduleIndexSave();
	}

	async function waitConvertCapacity() {
		while (convertPool.pending >= convertQueueCap) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	async function prepareNode({ pathName, node, exclude, childOctants = [] }) {
		await ensureIndexLoaded();
		if (exportedPaths.has(pathName)) {
			return null;
		}
		if (childOctants.length > 0) {
			index.childMap[pathName] = childOctants.slice().sort();
		}

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ere-osgb-"));
		const gridTile = pathNameToGridTile(pathName, gridOptions);
		const writer = createNodeWriter(tempDir, pathName, coordinateTransform, clipFilter);
		const wroteAny = writer.writeNode(node, pathName, exclude);
		if (!wroteAny) {
			await fs.remove(tempDir);
			return null;
		}

		const objPath = path.join(tempDir, "node.obj");
		const bounds = readObjBounds(objPath);
		if (!bounds) {
			await fs.remove(tempDir);
			return null;
		}

		const tileDir = path.join(outputDir, "Data", gridTile);
		await fs.ensureDir(tileDir);
		const osgbName = buildOsgbFileName(gridTile, pathName);
		const outputPath = path.join(tileDir, osgbName);

		return {
			pathName,
			convertJob: {
				workDir: tempDir,
				inputName: "node.obj",
				outputPath,
				tempDir,
			},
			indexEntry: {
				gridTile,
				osgbFile: osgbName,
				bounds,
				flat: true,
			},
		};
	}

	async function submitConvert(prep, { onSuccess, onError } = {}) {
		await waitConvertCapacity();
		convertSubmitted++;
		convertPool.enqueue(prep.convertJob)
			.then(() => {
				recordExportedNode(prep.pathName, prep.indexEntry);
				if (onSuccess) onSuccess();
			})
			.catch((error) => {
				convertErrors.push({ pathName: prep.pathName, error: error.message || String(error) });
				if (onError) onError(error);
			});
	}

	async function writeNode(args) {
		const prep = await prepareNode(args);
		if (!prep) return false;
		try {
			await convertPool.enqueue(prep.convertJob);
		} catch (error) {
			convertErrors.push({ pathName: prep.pathName, error: error.message || String(error) });
			return false;
		}
		recordExportedNode(prep.pathName, prep.indexEntry);
		return true;
	}

	async function flush() {
		await ensureIndexLoaded();
		await convertPool.drain();
		if (indexTimer) {
			clearTimeout(indexTimer);
			indexTimer = null;
		}
		if (indexDirty) await saveIndex();

		return {
			exportedCount: exportedPaths.size,
			exportedPaths: [...exportedPaths].sort(),
			childMap: index.childMap,
			index,
			gridCellSize: cellSize,
			convertStats: {
				converted: convertPool.converted,
				failed: convertPool.failed + convertErrors.length,
				errors: convertErrors,
			},
		};
	}

	return {
		prepareNode,
		submitConvert,
		writeNode,
		flush,
		getIndex: () => index,
		get exportedCount() { return exportedPaths.size; },
		get convertPending() { return convertPool.pending; },
		get convertQueueCap() { return convertQueueCap; },
		get convertSubmitted() { return convertSubmitted; },
		get convertWorkers() { return convertWorkers; },
	};
}

module.exports = {
	indexPath,
	loadIndex,
	createOsgbStreamRegistry,
};
