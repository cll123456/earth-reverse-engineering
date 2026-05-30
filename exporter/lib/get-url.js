"use strict";

const { fetch, ProxyAgent } = require("undici");
const { runInPool, configureFetchPool, getPoolConcurrency, getPoolStats } = require("./fetch-pool");

let proxyUrl = null;
let proxyDispatcher = null;
let requestTimeoutMs = 120000;
let nodeRequestTimeoutMs = 60000;
let nodeMaxTries = 3;

function resolveProxyUrl(explicitProxy) {
	if (explicitProxy) return explicitProxy;
	return process.env.HTTPS_PROXY
		|| process.env.https_proxy
		|| process.env.HTTP_PROXY
		|| process.env.http_proxy
		|| process.env.ALL_PROXY
		|| process.env.all_proxy
		|| null;
}

function configureGetUrl({
	rateLimitMs = 0,
	proxy = null,
	timeoutMs = 120000,
	nodeTimeoutMs = 60000,
	nodeMaxTries: maxNodeTries = 3,
	concurrency = 4,
	bulkConcurrency = null,
	nodeConcurrency = null,
} = {}) {
	proxyUrl = resolveProxyUrl(proxy);
	requestTimeoutMs = timeoutMs;
	nodeRequestTimeoutMs = nodeTimeoutMs;
	nodeMaxTries = maxNodeTries;
	const nodeLimit = nodeConcurrency || concurrency;
	proxyDispatcher = proxyUrl ? new ProxyAgent({
		uri: proxyUrl,
		connect: { timeout: requestTimeoutMs },
		connections: Math.max(nodeLimit, bulkConcurrency || concurrency || 4),
	}) : null;
	configureFetchPool({
		bulkConcurrency: bulkConcurrency || concurrency,
		nodeConcurrency: nodeConcurrency || concurrency,
		rateLimitMs,
	});
}

async function getUrl(url, autoRetry = true, cache = null, poolKind = "bulk") {
	const fetchFn = async () => {
		if (cache && cache.enabled) {
			const cached = await cache.read(url);
			if (cached) return cached;
		}
		const payload = await (autoRetry
			? _autoRetry(() => _getUrl(url, poolKind), (ex, tries, backOff) => {
				console.error(`Retrying ${url} in ${backOff} ${backOff === 1 ? "second" : "seconds"}. (${formatError(ex)})`);
			}, (ex, tries) => {
				console.error(`Gave up after ${tries} ${tries === 1 ? "try" : "tries"}.`);
				if (isConnectivityError(ex)) printConnectivityHelp(ex);
				throw ex;
			}, poolKind === "node" ? nodeMaxTries : 5)
			: _getUrl(url, poolKind));
		if (cache && cache.enabled) {
			await cache.write(url, payload);
		}
		return payload;
	};

	return runInPool(fetchFn, poolKind);
}

function formatError(error) {
	if (!error) return "unknown error";
	if (error.code) return error.code;
	if (error.name === "AbortError") return "timeout";
	return error.message || String(error);
}

function isConnectivityError(error) {
	const codes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"];
	if (error && codes.includes(error.code)) return true;
	return error && (error.name === "AbortError" || error.name === "ConnectTimeoutError");
}

function isRetryableError(error) {
	if (!error) return true;
	const message = error.message || String(error);
	if (/HTTP status code 4\d\d/.test(message)) return false;
	return true;
}

function printConnectivityHelp(error) {
	console.error("\nNetwork connection failed from Node.js.");
	console.error(`Error: ${formatError(error)}`);
	if (!proxyUrl) {
		console.error("Browser access to Google does not automatically apply to Node.js.");
		console.error("Try:");
		console.error("  node check_network.js --proxy http://127.0.0.1:7890");
		console.error("  node dump_region.js ... --proxy http://127.0.0.1:7890");
		console.error("Clash users can also try socks5://127.0.0.1:7891");
	} else {
		console.error(`Current proxy: ${proxyUrl}`);
		console.error("Run: node check_network.js --proxy " + proxyUrl);
	}
}

async function _getUrl(url, poolKind = "bulk") {
	const controller = new AbortController();
	const timeoutMs = poolKind === "node" ? nodeRequestTimeoutMs : requestTimeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			dispatcher: proxyDispatcher || undefined,
			signal: controller.signal,
			redirect: "follow",
		});
		if (!response.ok) {
			throw new Error(`HTTP status code ${response.status} for ${url}`);
		}
		return Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
}

async function _autoRetry(fn, log = null, gaveUp = null, MAX_TRIES = 5, MAX_BACKOFF_SECS = 16) {
	for (let tries = 1, backOff = 1; ; tries++, backOff = Math.min(2 * backOff, MAX_BACKOFF_SECS)) {
		try {
			return await fn();
		} catch (ex) {
			if (!isRetryableError(ex)) throw ex;
			if (tries >= MAX_TRIES) {
				if (gaveUp) return gaveUp(ex, tries, backOff);
				throw ex;
			}
			if (log) log(ex, tries, backOff);
			await new Promise((resolve) => setTimeout(resolve, 1000 * backOff));
		}
	}
}

module.exports = getUrl;
module.exports.configureGetUrl = configureGetUrl;
module.exports.getConfiguredProxy = () => proxyUrl;
module.exports.getPoolConcurrency = getPoolConcurrency;
module.exports.getPoolStats = getPoolStats;
