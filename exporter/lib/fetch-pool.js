"use strict";

const { createAsyncPool } = require("./async-pool");

let bulkPool = null;
let nodePool = null;
let rateLimitMs = 0;
let lastRequestAt = 0;

function configureFetchPool({
	bulkConcurrency = 16,
	nodeConcurrency = 24,
	concurrency = null,
	rateLimitMs: limitMs = 0,
} = {}) {
	const bulk = concurrency || bulkConcurrency;
	const node = concurrency || nodeConcurrency;
	bulkPool = createAsyncPool(bulk);
	nodePool = createAsyncPool(node);
	rateLimitMs = Math.max(0, limitMs || 0);
	lastRequestAt = 0;
}

async function waitRateLimit() {
	if (!rateLimitMs) return;
	const now = Date.now();
	const waitMs = Math.max(0, rateLimitMs - (now - lastRequestAt));
	if (waitMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
	lastRequestAt = Date.now();
}

function runInPool(fn, poolKind = "bulk") {
	if (!bulkPool || !nodePool) {
		configureFetchPool({});
	}
	const pool = poolKind === "node" ? nodePool : bulkPool;
	return pool.run(async () => {
		await waitRateLimit();
		return fn();
	});
}

function getPoolConcurrency() {
	return {
		bulk: bulkPool ? bulkPool.concurrency : 0,
		node: nodePool ? nodePool.concurrency : 0,
	};
}

function getPoolStats() {
	return {
		bulk: bulkPool ? bulkPool.getStats() : { pending: 0 },
		node: nodePool ? nodePool.getStats() : { pending: 0 },
	};
}

module.exports = {
	configureFetchPool,
	runInPool,
	getPoolConcurrency,
	getPoolStats,
};
