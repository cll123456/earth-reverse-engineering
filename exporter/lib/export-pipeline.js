"use strict";

const path = require("path");
const { createAsyncPool } = require("./async-pool");
const { createTileWriterRegistry } = require("./tile-writer-registry");

const EXPORT_JOB_TIMEOUT_MS = 90000;

function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

function createExportPipeline({
	workers,
	outputDir,
	getNode,
	progressTracker,
	transformConfig,
	clipPolygons,
	clipEnabled,
	tileGroupLevel,
	maxNodesPerTile = null,
	maxQueue = null,
}) {
	const exportConcurrency = Math.min(Math.max(8, workers), 20);
	const exportPool = createAsyncPool(exportConcurrency);
	const maxPending = maxQueue || exportConcurrency * 4;
	const tileRegistry = createTileWriterRegistry({
		outputDir,
		transformConfig,
		clipPolygons,
		clipEnabled,
		tileGroupLevel,
		maxNodesPerTile: maxNodesPerTile || undefined,
	});

	let exportedCount = 0;
	let skippedCount = 0;
	let failedCount = 0;
	let emptyCount = 0;
	let queuedCount = 0;

	async function waitForCapacity() {
		while (exportPool.getStats().pending >= maxPending) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	async function enqueue({ pathName, bulk, index, exclude }) {
		if (progressTracker && progressTracker.isExported(pathName)) {
			skippedCount++;
			return;
		}

		await waitForCapacity();
		queuedCount++;
		exportPool.run(async () => {
			try {
				await withTimeout((async () => {
					const node = await getNode(pathName, bulk, index);
					const wroteAny = await tileRegistry.writeNode({ pathName, node, exclude });
					if (wroteAny) {
						if (progressTracker) {
							await progressTracker.markCompleted(pathName);
						}
						exportedCount++;
						if (exportedCount <= 5 || exportedCount % 25 === 0) {
							const poolStats = exportPool.getStats();
							console.log(
								`exported ${exportedCount}/${queuedCount} nodes -> `
								+ `${tileRegistry.mergedTileCount} merged tiles `
								+ `(active ${poolStats.active}/${exportConcurrency}, queued ${poolStats.queued}, failed ${failedCount})`,
							);
						}
					} else {
						emptyCount++;
					}
				})(), EXPORT_JOB_TIMEOUT_MS, pathName);
			} catch (error) {
				failedCount++;
				if (failedCount <= 15 || failedCount % 25 === 0) {
					console.error(`export failed ${pathName}:`, error.message || error);
				}
			}
		});
	}

	async function drain() {
		await exportPool.drain();
		const registryStats = await tileRegistry.finalize();
		if (progressTracker && progressTracker.flush) {
			await progressTracker.flush();
		}
		return {
			exportedCount,
			skippedCount,
			failedCount,
			emptyCount,
			queuedCount,
			mergedTileCount: registryStats.mergedTileCount,
		};
	}

	return {
		enqueue,
		drain,
		get exportedCount() { return exportedCount; },
		get skippedCount() { return skippedCount; },
		get failedCount() { return failedCount; },
		get emptyCount() { return emptyCount; },
		get queuedCount() { return queuedCount; },
		get pendingCount() { return exportPool.getStats().pending; },
		get maxQueue() { return maxPending; },
		get exportConcurrency() { return exportConcurrency; },
		get mergedTileCount() { return tileRegistry.mergedTileCount; },
	};
}

module.exports = {
	createExportPipeline,
};
