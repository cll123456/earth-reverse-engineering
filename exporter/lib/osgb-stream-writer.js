"use strict";

const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createCoordinateTransform, createEnuTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createNodeWriter } = require("./mesh-writer");
const { createOsgbConvertPool } = require("./osgb-convert-pool");
const { createWorkerPool } = require("./worker-pool");
const decodeResource = require("./decode-resource");
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
const { stagingNodeDir } = require("./osgb-staging-writer");
const { buildStagedGeodeJobs } = require("./osgb-densify-pyramid");

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
	decodeWorkers = 0,
}) {
	const coordinateTransform = transformConfig
		? createCoordinateTransform(transformConfig.epsgInfo, transformConfig.bbox, transformConfig.globeRadius)
		: null;
	const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);
	const convertPool = createOsgbConvertPool({ concurrency: convertWorkers });
	// Off-main-thread decode pool. decodeResource (protobuf/mesh) + texture decode +
	// OBJ writing are the real per-node CPU cost; parallelising them across threads is
	// the main throughput win. Falls back to main-thread prepareNode if disabled or if
	// the pool fails to start.
	let decodeWorkerPool = null;
	if (decodeWorkers > 0) {
		try {
			decodeWorkerPool = createWorkerPool(path.join(__dirname, "osgb-decode-worker.js"), decodeWorkers);
		} catch (error) {
			console.warn(`Decode worker pool unavailable, using main thread: ${error.message || error}`);
			decodeWorkerPool = null;
		}
	}
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

	// Same as prepareNode, but the decode + OBJ/texture write run in a worker thread
	// (off the main thread). The worker returns just the temp dir + bounds; the heavy
	// decoded mesh/texture data is written to disk inside the worker and never crosses
	// the thread boundary. Index bookkeeping stays on the main thread.
	async function prepareNodeFromPayload({ pathName, payloadJob, exclude, childOctants = [] }) {
		if (!decodeWorkerPool) {
			// Pool disabled or already torn down (late mesh-fallback / backfill job after
			// the export finished). Decode on the main thread so the node still exports.
			const node = (await decodeResource(payloadJob.command, Buffer.from(payloadJob.payload))).payload;
			return prepareNode({ pathName, node, exclude, childOctants });
		}
		await ensureIndexLoaded();
		if (exportedPaths.has(pathName)) {
			return null;
		}
		if (childOctants.length > 0) {
			index.childMap[pathName] = childOctants.slice().sort();
		}

		const result = await decodeWorkerPool.run({
			pathName,
			exclude,
			command: payloadJob.command,
			payload: payloadJob.payload,
			transformConfig,
			clipPolygons,
			clipEnabled,
		});
		if (!result.wroteAny || !result.tempDir || !result.bounds) {
			if (result.tempDir) await fs.remove(result.tempDir).catch(() => {});
			return null;
		}

		const gridTile = pathNameToGridTile(pathName, gridOptions);
		const tileDir = path.join(outputDir, "Data", gridTile);
		await fs.ensureDir(tileDir);
		const osgbName = buildOsgbFileName(gridTile, pathName);
		const outputPath = path.join(tileDir, osgbName);

		return {
			pathName,
			convertJob: {
				workDir: result.tempDir,
				inputName: "node.obj",
				outputPath,
				tempDir: result.tempDir,
			},
			indexEntry: {
				gridTile,
				osgbFile: osgbName,
				bounds: result.bounds,
				flat: true,
			},
		};
	}

	// LOD-pyramid (model C) staging: decode + write the UNMASKED node mesh (exclude=[])
	// to a persistent .staging/nodes/<path>/ dir for later per-level merging. Records the
	// node in the index (gridTile + bounds) but does NOT convert to a standalone osgb.
	const stagingDir = path.join(outputDir, ".staging");
	async function prepareNodeStaging({ pathName, payloadJob, node = null, exclude = [], childOctants = [] }) {
		await ensureIndexLoaded();
		if (exportedPaths.has(pathName)) return null;
		if (childOctants.length > 0) {
			index.childMap[pathName] = childOctants.slice().sort();
		}
		const outDir = stagingNodeDir(stagingDir, pathName);
		// Full (unmasked) mesh is always written; the masked mesh (child octants removed)
		// is written for internal nodes as the "near" geode of the densified pyramid.
		const maskOctants = childOctants;

		let result;
		if (decodeWorkerPool && payloadJob) {
			result = await decodeWorkerPool.run({
				pathName,
				exclude,
				maskOctants,
				outDir,
				command: payloadJob.command,
				payload: payloadJob.payload,
				transformConfig,
				clipPolygons,
				clipEnabled,
			});
		} else {
			const decodedNode = node
				|| (await decodeResource(payloadJob.command, Buffer.from(payloadJob.payload))).payload;
			await fs.ensureDir(outDir);
			const writer = createNodeWriter(outDir, pathName, coordinateTransform, clipFilter);
			const wroteAny = writer.writeNode(decodedNode, pathName, exclude);
			if (!wroteAny) {
				await fs.remove(outDir);
				result = { wroteAny: false };
			} else {
				const bounds = readObjBounds(path.join(outDir, "node.obj"));
				if (!bounds) {
					await fs.remove(outDir);
					result = { wroteAny: false };
				} else {
					if (maskOctants.length > 0) {
						const maskedDir = path.join(outDir, "_masked");
						await fs.ensureDir(maskedDir);
						const maskedWriter = createNodeWriter(maskedDir, pathName, coordinateTransform, clipFilter);
						if (!maskedWriter.writeNode(decodedNode, pathName, maskOctants)) {
							await fs.remove(maskedDir);
						}
					}
					result = { wroteAny: true, bounds };
				}
			}
		}

		if (!result.wroteAny || !result.bounds) return null;
		const gridTile = pathNameToGridTile(pathName, gridOptions);
		recordExportedNode(pathName, { gridTile, bounds: result.bounds, flat: true });
		return { pathName, gridTile };
	}

	// Densified-pyramid streaming build: convert a just-staged node's geode(s) into Data/
	// right away (leaf -> entry geode; internal -> _complete + _masked). osgconv on the
	// node mesh is independent per node, so this lets Data/ grow during streaming instead
	// of deferring every conversion to finalize. The internal-node wrapper (which needs the
	// global child set) is written later by finalizeDensifiedWrappers. All geode jobs are
	// enqueued synchronously here so convertPool.drain() can't miss a not-yet-queued job.
	const dataDir = path.join(outputDir, "Data");
	// Once a node's geode(s) are in Data/, the staged mesh is dead weight — finalize builds
	// the wrappers/roots from Data + the index, never from .staging. So prune each node's
	// staging dir after its conversion to keep .staging from growing unbounded on big runs.
	// Set ERE_KEEP_STAGING=1 to retain it (enables `build:densify` full offline rebuild).
	const pruneStaging = process.env.ERE_KEEP_STAGING !== "1";
	async function submitStagedGeodes({ pathName, gridTile, isLeaf }, { onSuccess, onError } = {}) {
		const built = buildStagedGeodeJobs({ stagingDir, dataDir, gridTile, pathName, isLeaf });
		if (!built) {
			if (onError) onError(new Error(`no staged mesh for ${pathName}`));
			return;
		}
		await fs.ensureDir(built.tileDir);
		await waitConvertCapacity();
		convertSubmitted += built.jobs.length;
		Promise.all(built.jobs.map((job) => convertPool.enqueue(job)))
			.then(() => {
				if (pruneStaging) fs.remove(stagingNodeDir(stagingDir, pathName)).catch(() => {});
				if (onSuccess) onSuccess();
			})
			.catch((error) => {
				convertErrors.push({ pathName, error: error.message || String(error) });
				if (onError) onError(error);
			});
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

	async function destroy() {
		if (decodeWorkerPool) {
			try { await decodeWorkerPool.destroy(); } catch { /* ignore */ }
			decodeWorkerPool = null;
		}
	}

	return {
		prepareNode,
		prepareNodeFromPayload,
		prepareNodeStaging,
		submitStagedGeodes,
		submitConvert,
		writeNode,
		flush,
		destroy,
		saveIndex,
		stagingDir,
		getIndex: () => index,
		get decodeWorkerEnabled() { return !!decodeWorkerPool; },
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
