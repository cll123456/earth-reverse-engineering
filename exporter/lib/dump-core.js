"use strict";

const fs = require("fs-extra");
const path = require("path");
const { initLegacyObjWriter } = require("./mesh-writer");
const { isNotFoundError } = require("./octant-online-search");
const { boxesIntersect, pathToBox } = require("./octant-geo");
const { createAsyncPool } = require("./async-pool");
const { createExportPipeline } = require("./export-pipeline");
const { createOsgbExportPipeline } = require("./osgb-export-pipeline");
const { collectLodAncestorPaths } = require("./osgb-lod-backfill");

function createDumpCore({
	getPlanetoid,
	getBulk,
	getNode,
	getNodePayload = null,
	bulk: { getIndexByPath, hasBulkMetadataAtIndex, hasNodeAtIndex },
}) {
	async function checkNodeAtNodePath(rootEpoch, nodePath) {
		try {
			let bulk = null;
			let index = -1;
			for (let epoch = rootEpoch, i = 4; i < nodePath.length + 4; i += 4) {
				const bulkPath = nodePath.substring(0, i - 4);
				const subPath = nodePath.substring(0, i);

				if (bulk) {
					const idx = getIndexByPath(bulk, bulkPath);
					if (hasBulkMetadataAtIndex(bulk, idx)) return null;
				}

				const nextBulk = await getBulk(bulkPath, epoch);
				bulk = nextBulk;
				index = getIndexByPath(bulk, subPath);
				if (index < 0) return null;
				epoch = bulk.bulkMetadataEpoch[index];
			}
			if (index < 0) return null;
			if (!hasNodeAtIndex(bulk, index)) return null;
			return { bulk, index };
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	}

	function initNodeSearch(rootEpoch, numParallelBranches, nodeFound, nodeDownloaded, regionBbox = null, deferNodeFetch = false, shouldAbort = null) {
		const sem = {
			concurrent: numParallelBranches,
			waiting: [],
			wait(highestPriority = false) {
				return new Promise((resolve) => {
					if (this.concurrent <= 0) {
						if (highestPriority) this.waiting.splice(0, 0, resolve);
						else this.waiting.push(resolve);
					} else {
						this.concurrent--;
						resolve();
					}
				});
			},
			signal() {
				this.concurrent++;
				if (this.concurrent > 0 && this.waiting.length > 0) {
					this.concurrent--;
					this.waiting.splice(0, 1)[0]();
				}
			},
		};

		return async function search(k, maxLevel = 999) {
			if (shouldAbort && shouldAbort()) return false;
			if (k.length > maxLevel) return false;
			if (regionBbox && !boxesIntersect(pathToBox(k), regionBbox)) return false;

			let check;
			try {
				check = await checkNodeAtNodePath(rootEpoch, k);
				if (check === null) return false;
			} catch (ex) {
				console.error(ex);
				return false;
			}

			try {
				if (nodeFound) nodeFound(k);
			} catch (ex) {
				console.error("Unhandled nodeFound callback error", ex);
				return false;
			}

			const promises = [];
			const results = [];

			for (const oct of [0, 1, 2, 3, 4, 5, 6, 7]) {
				promises.push((async function fn() {
					try {
						results.push({ oct, res: await search(String(k) + oct, maxLevel) });
						if (results.length === 8) {
							const octs = results.filter(({ res }) => res).map(({ oct }) => oct);
							if (nodeDownloaded) {
								if (deferNodeFetch) {
									await nodeDownloaded(k, check.bulk, check.index, octs);
								} else {
									const node = await getNode(k, check.bulk, check.index);
									await nodeDownloaded(k, node, octs);
								}
							}
						}
					} finally {
						await new Promise((resolve) => setImmediate(resolve));
						sem.signal();
					}
				})());
				await sem.wait(true);
			}

			try {
				await Promise.all(promises);
			} catch (ex) {
				console.error(ex);
				return false;
			}
			return true;
		};
	}

	async function dumpOctants({
		octants,
		maxLevel,
		parallelSearch = true,
		workers = 4,
		outputMode = "legacy",
		outputDir,
		coordinateTransform = null,
		clipFilter = null,
		progressTracker = null,
		onNodeFound = null,
		regionBbox = null,
		tileGroupLevel = null,
		maxNodesPerTile = null,
		transformConfig = null,
		clipPolygons = null,
		exportMode = "osgb",
		pyramidMode = false,
		shouldAbort = null,
	}) {
		const planetoid = await getPlanetoid();
		const rootEpoch = planetoid.bulkMetadataEpoch[0];
		let legacyWriter = null;

		if (outputMode === "legacy") {
			fs.removeSync(outputDir);
			fs.ensureDirSync(outputDir);
			legacyWriter = initLegacyObjWriter(outputDir);
		} else if (outputMode === "tiles") {
			fs.ensureDirSync(path.join(outputDir, "Data"));
		}

		if (outputMode === "legacy") {
			let nodeCount = 0;
			const search = initNodeSearch(
				rootEpoch,
				parallelSearch ? Math.min(32, Math.max(4, workers * 2)) : 1,
				(pathName) => {
					nodeCount++;
					if (onNodeFound) onNodeFound(pathName);
				},
				async (pathName, node, octsToExclude) => {
					legacyWriter.writeNode(node, pathName, octsToExclude);
				},
				regionBbox,
			);
			const rootPool = createAsyncPool(Math.min(octants.length, workers));
			await rootPool.map(octants, (oct) => search(oct, maxLevel));
			return { rootEpoch, nodeCount, exportedCount: nodeCount, tileNames: [] };
		}

		let nodeCount = 0;
		let skippedInternal = 0;
		const visitMap = new Map();
		const branchParallelism = parallelSearch
			? Math.min(32, Math.max(8, workers * 2))
			: 1;

		const exportPipeline = exportMode === "osgb"
			? createOsgbExportPipeline({
				workers,
				outputDir,
				getNode,
				getNodePayload,
				checkNodeAtNodePath,
				rootEpoch,
				progressTracker,
				transformConfig,
				clipPolygons,
				clipEnabled: clipFilter ? clipFilter.enabled : false,
				bbox: transformConfig?.bbox || regionBbox,
				regionBbox,
				epsgCode: transformConfig?.epsgCode || "EPSG:3857",
				srsOrigin: transformConfig?.srsOrigin || [0, 0, 0],
				maxLevel,
				pyramidMode,
			})
			: createExportPipeline({
				workers,
				outputDir,
				getNode,
				progressTracker,
				transformConfig,
				clipPolygons,
				clipEnabled: clipFilter ? clipFilter.enabled : false,
				tileGroupLevel,
				maxNodesPerTile,
			});

		if (exportMode === "osgb") {
			console.log("Export mode: OSGB streaming (temp OBJ -> osgconv -> Data/, immediate cleanup)");
			console.log(
				`  download concurrency: ${exportPipeline.exportConcurrency}, `
				+ `decode workers: ${exportPipeline.decodeWorkers || "off (main thread)"}, `
				+ `osgconv workers: ${exportPipeline.convertWorkers}`,
			);
		} else if (tileGroupLevel) {
			console.log(`Merging leaf nodes into ~L${tileGroupLevel} tile blocks during export`);
		}
		console.log("Discovering nodes + exporting tiles in parallel...");
		if (exportMode === "osgb") {
			console.log("  phase 1: stream leaf nodes to Data/*.osgb; phase 2: LOD ancestor backfill");
		} else {
			console.log("  internal nodes skipped (children export finer detail)");
		}
		console.log(
			`  export concurrency: ${exportPipeline.exportConcurrency}, `
			+ `queue cap: ${exportPipeline.maxQueue}`,
		);

		const search = initNodeSearch(
			rootEpoch,
			branchParallelism,
			(pathName) => {
				nodeCount++;
				if (onNodeFound) {
					onNodeFound(pathName);
				} else if (nodeCount % 500 === 0) {
					const poolStats = exportPipeline.exportPoolStats || { active: 0, queued: 0 };
					console.log(
						`discovered ${nodeCount} nodes, `
						+ `osgb ${exportPipeline.exportedCount}, `
						+ `download ${exportPipeline.downloadOutstanding}/${exportPipeline.maxQueue}, `
						+ `convert ${exportPipeline.convertPending}/${exportPipeline.convertQueueCap}, `
						+ `pool q ${poolStats.queued}, failed ${exportPipeline.failedCount}`,
					);
				}
			},
			async (pathName, bulk, index, exclude) => {
				visitMap.set(pathName, exclude.slice());
				if (exportMode !== "osgb" && exclude.length > 0) {
					skippedInternal++;
					return;
				}
				if (exportMode === "osgb" && exclude.length > 0) {
					skippedInternal++;
					return;
				}
				await exportPipeline.enqueue({
					pathName,
					bulk,
					index,
					exclude,
					childOctants: exclude,
				});
			},
			regionBbox,
			true,
			shouldAbort,
		);

		let lastExported = 0;
		let lastProgressAt = Date.now();
		const stallWatchdog = setInterval(() => {
			const exported = exportPipeline.exportedCount;
			const pending = exportPipeline.pendingCount;
			if (exported > lastExported) {
				lastExported = exported;
				lastProgressAt = Date.now();
				return;
			}
			if (pending > 0 && Date.now() - lastProgressAt > 45000) {
				const poolStats = exportPipeline.exportPoolStats || { active: 0, queued: 0 };
				console.warn(
					`Export stalled 45s+ at ${exported} osgb `
					+ `(download ${exportPipeline.downloadOutstanding}/${exportPipeline.maxQueue}, `
					+ `convert ${exportPipeline.convertPending}/${exportPipeline.convertQueueCap}, `
					+ `pool q ${poolStats.queued}, failed ${exportPipeline.failedCount}) — slow network/osgconv?`,
				);
				lastProgressAt = Date.now();
			}
		}, 15000);

		try {
			const rootPool = createAsyncPool(Math.min(octants.length, workers));
			await rootPool.map(octants, (oct) => search(oct, maxLevel));
		} finally {
			clearInterval(stallWatchdog);
		}

		const interrupted = shouldAbort && shouldAbort();
		console.log(
			interrupted
				? `Discovery stopped (${nodeCount} nodes visited). Saving in-flight exports...`
				: `Discovery complete: ${nodeCount} nodes visited, ${skippedInternal} internal deferred, `
					+ `waiting for leaf exports (in-flight ${exportPipeline.pendingCount})...`,
		);

		let exportStats;
		if (exportMode === "osgb" && interrupted) {
			exportStats = await exportPipeline.savePartialOsgb("interrupted");
		} else {
			exportStats = await exportPipeline.drain();
		}

		if (exportMode === "osgb" && !interrupted) {
			const backfillPaths = collectLodAncestorPaths(exportStats.exportedPaths || []);
			const pendingBackfill = backfillPaths.filter(
				(pathName) => !(progressTracker && progressTracker.isExported(pathName)),
			);
			if (pendingBackfill.length > 0) {
				console.log(
					`LOD backfill: ${pendingBackfill.length} ancestor node(s) for PagedLOD chain...`,
				);
				for (const pathName of pendingBackfill) {
					const check = await checkNodeAtNodePath(rootEpoch, pathName);
					if (!check) continue;
					const childOctants = visitMap.get(pathName) || [];
					await exportPipeline.enqueue({
						pathName,
						bulk: check.bulk,
						index: check.index,
						exclude: childOctants,
						childOctants,
					});
				}
				const backfillStats = await exportPipeline.drain();
				exportStats.exportedCount = backfillStats.exportedCount;
				exportStats.exportedPaths = backfillStats.exportedPaths;
				exportStats.failedCount = backfillStats.failedCount;
				exportStats.index = backfillStats.index;
			}

			if (exportStats.index) {
				for (const [pathName, childOctants] of visitMap.entries()) {
					if (childOctants.length > 0) {
						exportStats.index.childMap[pathName] = childOctants.slice().sort();
					}
				}
			}
			const osgbStats = await exportPipeline.finalizeLod(exportStats.index);
			exportStats.osgb = osgbStats;
		} else if (exportMode === "osgb" && interrupted) {
			console.log(
				`Partial OSGB saved: ${exportStats.osgb?.rootFiles || 0} root tile(s), `
				+ `${exportStats.exportedCount || 0} node(s) — importable in DasViewer now`,
			);
		}

		const childMap = exportMode === "osgb"
			? (exportStats.index?.childMap || Object.fromEntries(visitMap.entries()))
			: (exportStats.childMap || {});

		console.log(
			exportMode === "osgb"
				? `Export complete: ${exportStats.exportedCount} osgb nodes, `
					+ `${exportStats.failedCount} failed, ${exportStats.emptyCount} empty, `
					+ `${exportStats.fallbackEnqueueCount || 0} finer fallback, `
					+ `${exportStats.skippedCount} resume-skipped`
				: `Export complete: ${exportStats.exportedCount} nodes -> ${exportStats.mergedTileCount} merged tiles, `
					+ `${exportStats.failedCount} failed, ${exportStats.emptyCount} empty, `
					+ `${exportStats.skippedCount} resume-skipped, ${skippedInternal} internal skipped`,
		);

		// All draining, backfill and finalize are done — safe to terminate decode
		// worker threads so the process can exit cleanly.
		if (exportPipeline.destroy) {
			await exportPipeline.destroy();
		}

		let tileNames = [];
		if (exportMode === "osgb") {
			tileNames = exportStats.osgb?.gridTileNames || [];
		} else {
			const dataDir = path.join(outputDir, "Data");
			if (await fs.pathExists(dataDir)) {
				const entries = await fs.readdir(dataDir);
				for (const entry of entries) {
					if (entry.startsWith("Tile_")) tileNames.push(entry);
				}
			}
		}

		return {
			rootEpoch,
			nodeCount,
			exportJobCount: exportStats.queuedCount,
			mergedTileCount: exportStats.mergedTileCount || 0,
			skippedInternal,
			exportedCount: exportStats.exportedCount,
			skippedCount: exportStats.skippedCount,
			failedCount: exportStats.failedCount,
			emptyCount: exportStats.emptyCount,
			exportedPaths: exportStats.exportedPaths || [],
			childMap,
			osgb: exportStats.osgb || null,
			tileNames,
			partial: !!exportStats.partial,
		};
	}

	return {
		checkNodeAtNodePath,
		initNodeSearch,
		dumpOctants,
	};
}

module.exports = {
	createDumpCore,
};
