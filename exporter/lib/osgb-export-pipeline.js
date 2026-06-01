"use strict";

const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createAsyncPool } = require("./async-pool");
const { createOsgbStreamRegistry } = require("./osgb-stream-writer");
const { finalizePagedLodRegion } = require("./osgb-paged-lod");
const { buildDensifiedPyramidRegion } = require("./osgb-densify-pyramid");
const { ensureIndexChildMap } = require("./osgb-index");
const { boxesIntersect, pathToBox } = require("./octant-geo");

const EXPORT_JOB_TIMEOUT_MS = 180000;
const MAX_EXPORT_RETRIES = 2;
const ROOT_FINALIZE_EVERY = 50;
const WRAP_FINALIZE_EVERY = 200;
const ROOT_FINALIZE_INTERVAL_MS = 90000;
const ABSOLUTE_MESH_MAX_LEVEL = 22;
const MESH_FALLBACK_DEPTH = 4;

function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

function createOsgbExportPipeline({
	workers,
	outputDir,
	getNode,
	getNodePayload = null,
	checkNodeAtNodePath,
	rootEpoch,
	progressTracker,
	transformConfig,
	clipPolygons,
	clipEnabled,
	bbox,
	regionBbox = null,
	epsgCode,
	srsOrigin,
	maxLevel,
	maxQueue = null,
	pyramidMode = false,
}) {
	const meshFallbackMaxLevel = Math.min(maxLevel + MESH_FALLBACK_DEPTH, ABSOLUTE_MESH_MAX_LEVEL);
	const exportConcurrency = Math.min(Math.max(4, Math.floor(workers * 0.75)), 12);
	const convertWorkers = Math.max(2, Math.min(6, Math.floor(workers / 2)));
	const exportPool = createAsyncPool(exportConcurrency);
	const maxPending = maxQueue || exportConcurrency * 2;

	// Decode worker threads run the per-node CPU work (protobuf/mesh + texture decode +
	// OBJ write) in parallel across cores instead of serially on the main thread. Only
	// useful if the caller supplied getNodePayload (raw-bytes fetch). Cap at the number
	// of jobs that can be in flight (exportConcurrency) and at available cores; override
	// with ERE_DECODE_WORKERS (set 0 to force the old main-thread path).
	const cpuCount = (os.cpus() || []).length || 4;
	const decodeWorkers = getNodePayload
		? (process.env.ERE_DECODE_WORKERS != null
			? Math.max(0, parseInt(process.env.ERE_DECODE_WORKERS, 10) || 0)
			: Math.min(exportConcurrency, Math.max(2, cpuCount - 1)))
		: 0;

	const streamRegistry = createOsgbStreamRegistry({
		outputDir,
		transformConfig,
		clipPolygons,
		clipEnabled,
		bbox,
		epsgCode,
		srsOrigin,
		maxLevel,
		convertWorkers,
		decodeWorkers,
	});
	const useDecodeWorkers = streamRegistry.decodeWorkerEnabled;

	let exportedCount = 0;
	let skippedCount = 0;
	let failedCount = 0;
	let emptyCount = 0;
	let queuedCount = 0;
	let downloadOutstanding = 0;
	let lastFlush = null;
	let finalizeBusy = false;
	let finalizeQueued = null;
	let lastRootFinalizeAt = 0;
	let lastWrapFinalizeCount = 0;
	let fallbackEnqueueCount = 0;
	let loggedFallbackHint = false;
	const fallbackScheduled = new Set();

	function scheduleFinerMeshFallback(pathName) {
		if (!checkNodeAtNodePath || rootEpoch == null) return;
		if (pathName.length >= meshFallbackMaxLevel) return;

		void (async () => {
			for (let oct = 0; oct < 8; oct++) {
				const childPath = `${pathName}${oct}`;
				if (fallbackScheduled.has(childPath)) continue;
				if (regionBbox && !boxesIntersect(pathToBox(childPath), regionBbox)) continue;
				if (progressTracker && progressTracker.isExported(childPath)) continue;

				let check;
				try {
					check = await checkNodeAtNodePath(rootEpoch, childPath);
				} catch {
					continue;
				}
				if (!check) continue;

				fallbackScheduled.add(childPath);
				fallbackEnqueueCount++;
				if (!loggedFallbackHint) {
					loggedFallbackHint = true;
					console.log(
						`  mesh fallback: empty L${maxLevel} nodes expand up to L${meshFallbackMaxLevel} for missing geometry`,
					);
				}
				// Do not await enqueue here — parent job still holds a download slot.
				void enqueue({
					pathName: childPath,
					bulk: check.bulk,
					index: check.index,
					exclude: [],
					childOctants: [],
				});
			}
		})().catch((error) => {
			console.warn(`mesh fallback failed for ${pathName}:`, error.message || error);
		});
	}

	async function runIncrementalFinalize({ rootsOnly = false, quiet = false } = {}) {
		if (finalizeBusy) {
			finalizeQueued = { rootsOnly, quiet };
			return null;
		}
		finalizeBusy = true;
		try {
			const flushResult = lastFlush || await streamRegistry.flush();
			lastFlush = flushResult;
			const index = ensureIndexChildMap(flushResult.index);
			if (Object.keys(index.nodes || {}).length === 0) {
				return null;
			}
			if (!quiet) {
				console.log(
					rootsOnly
						? `Updating DasViewer root tiles (${Object.keys(index.nodes).length} nodes on disk)...`
						: `Incremental PagedLOD update (${Object.keys(index.nodes).length} nodes)...`,
				);
			}
			const stats = await finalizePagedLodRegion(outputDir, {
				index,
				maxLevel,
				incremental: true,
				rootsOnly,
				saveIndex: true,
			});
			if (!quiet && (stats.rootFiles > 0 || stats.wrappedFiles > 0)) {
				console.log(
					`PagedLOD checkpoint: ${stats.rootFiles} root(s), `
					+ `${stats.wrappedFiles} wrapped, ${stats.gridTiles} grid tile(s)`,
				);
			}
			if (stats.errors.length > 0 && !quiet) {
				console.warn("PagedLOD checkpoint errors (first 3):", stats.errors.slice(0, 3));
			}
			return stats;
		} finally {
			finalizeBusy = false;
			if (finalizeQueued) {
				const next = finalizeQueued;
				finalizeQueued = null;
				setImmediate(() => {
					runIncrementalFinalize(next).catch((error) => {
						console.warn("PagedLOD checkpoint failed:", error.message || error);
					});
				});
			}
		}
	}

	function scheduleIncrementalFinalize(exportedNow) {
		const now = Date.now();
		const shouldUpdateRoots = exportedNow % ROOT_FINALIZE_EVERY === 0
			|| (now - lastRootFinalizeAt) >= ROOT_FINALIZE_INTERVAL_MS;
		const shouldWrap = exportedNow >= lastWrapFinalizeCount + WRAP_FINALIZE_EVERY;

		if (shouldWrap) {
			lastWrapFinalizeCount = exportedNow;
			lastRootFinalizeAt = now;
			runIncrementalFinalize({ rootsOnly: false, quiet: true }).catch((error) => {
				console.warn("PagedLOD wrap checkpoint failed:", error.message || error);
			});
			return;
		}

		if (shouldUpdateRoots) {
			lastRootFinalizeAt = now;
			runIncrementalFinalize({ rootsOnly: true, quiet: true }).catch((error) => {
				console.warn("PagedLOD root checkpoint failed:", error.message || error);
			});
		}
	}

	function tryAcquireDownloadSlot() {
		if (downloadOutstanding >= maxPending) return false;
		downloadOutstanding++;
		return true;
	}

	async function acquireDownloadSlot() {
		while (!tryAcquireDownloadSlot()) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	function releaseDownloadSlot() {
		downloadOutstanding = Math.max(0, downloadOutstanding - 1);
	}

	async function runDownloadJob({ pathName, bulk, index, exclude, childOctants }) {
		let lastError = null;
		for (let attempt = 0; attempt <= MAX_EXPORT_RETRIES; attempt++) {
			try {
				await withTimeout((async () => {
					if (pyramidMode) {
						// Model C: stage the UNMASKED node mesh; merging into complete
						// per-level meshes happens in finalize. No per-node osgconv here.
						let prep;
						if (useDecodeWorkers) {
							const payloadJob = await getNodePayload(pathName, bulk, index);
							prep = await streamRegistry.prepareNodeStaging({
								pathName, payloadJob, exclude: [], childOctants,
							});
						} else {
							const node = await getNode(pathName, bulk, index);
							prep = await streamRegistry.prepareNodeStaging({
								pathName, node, exclude: [], childOctants,
							});
						}
						if (!prep) {
							emptyCount++;
							scheduleFinerMeshFallback(pathName);
							return;
						}
						if (progressTracker) await progressTracker.markCompleted(pathName);
						exportedCount++;
						if (exportedCount <= 5 || exportedCount % 100 === 0) {
							const poolStats = exportPool.getStats();
							console.log(
								`staged ${exportedCount} `
								+ `(download ${downloadOutstanding}/${maxPending}, `
								+ `pool q ${poolStats.queued}, failed ${failedCount})`,
							);
						}
						return;
					}
					let prep;
					if (useDecodeWorkers) {
						const payloadJob = await getNodePayload(pathName, bulk, index);
						prep = await streamRegistry.prepareNodeFromPayload({
							pathName,
							payloadJob,
							exclude,
							childOctants,
						});
					} else {
						const node = await getNode(pathName, bulk, index);
						prep = await streamRegistry.prepareNode({
							pathName,
							node,
							exclude,
							childOctants,
						});
					}
					if (!prep) {
						emptyCount++;
						scheduleFinerMeshFallback(pathName);
						return;
					}
					await streamRegistry.submitConvert(prep, {
						onSuccess: async () => {
							if (progressTracker) {
								await progressTracker.markCompleted(pathName);
							}
							exportedCount++;
							scheduleIncrementalFinalize(exportedCount);
							if (exportedCount <= 5 || exportedCount % 25 === 0) {
								const poolStats = exportPool.getStats();
								console.log(
									`osgb ${exportedCount} `
									+ `(download ${downloadOutstanding}/${maxPending}, `
									+ `pool q ${poolStats.queued}, `
									+ `convert ${streamRegistry.convertPending}/${streamRegistry.convertQueueCap}, `
									+ `failed ${failedCount})`,
								);
							}
						},
						onError: (error) => {
							failedCount++;
							if (failedCount <= 15 || failedCount % 25 === 0) {
								console.error(`convert failed ${pathName}:`, error.message || error);
							}
						},
					});
				})(), EXPORT_JOB_TIMEOUT_MS, pathName);
				return;
			} catch (error) {
				lastError = error;
				if (attempt < MAX_EXPORT_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
				}
			}
		}
		failedCount++;
		if (failedCount <= 15 || failedCount % 25 === 0) {
			console.error(`export failed ${pathName}:`, lastError?.message || lastError);
		}
	}

	async function enqueue({ pathName, bulk, index, exclude, childOctants }) {
		if (progressTracker && progressTracker.isExported(pathName)) {
			skippedCount++;
			return;
		}

		await acquireDownloadSlot();
		queuedCount++;
		exportPool.run(async () => {
			try {
				await runDownloadJob({ pathName, bulk, index, exclude, childOctants });
			} finally {
				releaseDownloadSlot();
			}
		});
	}

	async function drain() {
		await exportPool.drain();
		lastFlush = await streamRegistry.flush();
		if (progressTracker && progressTracker.flush) {
			await progressTracker.flush();
		}
		return {
			exportedCount,
			skippedCount,
			failedCount: failedCount + (lastFlush.convertStats.failed || 0),
			emptyCount,
			fallbackEnqueueCount,
			queuedCount,
			exportedPaths: lastFlush.exportedPaths,
			childMap: lastFlush.childMap,
			index: lastFlush.index,
			gridCellSize: lastFlush.gridCellSize,
		};
	}

	async function finalizeLod(indexOverride = null, { partial = false } = {}) {
		if (!lastFlush) {
			lastFlush = await streamRegistry.flush();
		}
		const index = ensureIndexChildMap(indexOverride || lastFlush.index);
		const exportedPaths = Object.keys(index.nodes || {});
		const finestLevel = exportedPaths.length > 0
			? Math.max(maxLevel, ...exportedPaths.map((p) => p.length))
			: maxLevel;

		if (pyramidMode) {
			console.log("Building densified per-node dual-geode pyramid...");
			await streamRegistry.saveIndex();
			const pyramidStats = await buildDensifiedPyramidRegion(outputDir, {
				index,
				maxLevel: finestLevel,
			});
			return {
				...pyramidStats,
				gridTileNames: pyramidStats.tileNames,
				nodeFiles: lastFlush.exportedCount,
				partial,
			};
		}

		console.log(
			partial
				? "Saving partial PagedLOD (safe to open in DasViewer)..."
				: "Wrapping PagedLOD links for internal nodes...",
		);
		const lodStats = await finalizePagedLodRegion(outputDir, {
			index,
			maxLevel: finestLevel,
			incremental: partial,
			rootsOnly: false,
			saveIndex: true,
		});
		return {
			...lodStats,
			flatConverted: lastFlush.convertStats.converted,
			gridCellSize: lastFlush.gridCellSize,
			nodeFiles: lastFlush.exportedCount,
			partial,
		};
	}

	async function savePartialOsgb(reason = "interrupted") {
		console.log(`\nSaving partial OSGB (${reason}) — current progress will stay importable in DasViewer...`);
		const drained = await drain();
		if ((drained.exportedCount || 0) === 0) {
			return { ...drained, partial: true, osgb: null };
		}
		const osgbStats = await finalizeLod(drained.index, { partial: true });
		await fs.writeJson(
			path.join(outputDir, ".region-osgb-checkpoint.json"),
			{
				savedAt: new Date().toISOString(),
				reason,
				exportedCount: drained.exportedCount,
				...osgbStats,
			},
			{ spaces: 2 },
		);
		return {
			...drained,
			osgb: osgbStats,
			partial: true,
		};
	}

	// Terminate decode worker threads. Call once at the very end of the export (after
	// all drains, backfill and finalize), so late mesh-fallback / backfill jobs can
	// still use the pool. Idempotent.
	async function destroy() {
		await streamRegistry.destroy();
	}

	return {
		enqueue,
		drain,
		finalizeLod,
		runIncrementalFinalize,
		savePartialOsgb,
		destroy,
		get exportedCount() { return exportedCount; },
		get skippedCount() { return skippedCount; },
		get failedCount() { return failedCount; },
		get emptyCount() { return emptyCount; },
		get queuedCount() { return queuedCount; },
		get downloadOutstanding() { return downloadOutstanding; },
		get convertPending() { return streamRegistry.convertPending; },
		get convertQueueCap() { return streamRegistry.convertQueueCap; },
		get pendingCount() {
			return downloadOutstanding + exportPool.getStats().queued + streamRegistry.convertPending;
		},
		get maxQueue() { return maxPending; },
		get exportConcurrency() { return exportConcurrency; },
		get convertWorkers() { return convertWorkers; },
		get decodeWorkers() { return useDecodeWorkers ? decodeWorkers : 0; },
		get exportPoolStats() { return exportPool.getStats(); },
	};
}

module.exports = {
	createOsgbExportPipeline,
};
