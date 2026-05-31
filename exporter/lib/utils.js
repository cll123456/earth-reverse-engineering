"use strict";

const fs = require("fs-extra");
const path = require("path");
const getUrl = require("./get-url");
const decodeResource = require("./decode-resource");
const { createDownloadCache } = require("./download-cache");

const [CMD_BULK, CMD_NODE] = [0, 3];

module.exports = function init(config) {
	const {
		URL_PREFIX,
		DUMP_JSON_DIR,
		DUMP_RAW_DIR,
		DUMP_JSON,
		DUMP_RAW,
		CACHE_DIR = null,
		RATE_LIMIT_MS = 0,
		PROXY = null,
		TIMEOUT_MS = 120000,
		CONCURRENCY = 4,
		BULK_CONCURRENCY = null,
		NODE_CONCURRENCY = null,
		NODE_TIMEOUT_MS = 60000,
	} = config;

	getUrl.configureGetUrl({
		rateLimitMs: RATE_LIMIT_MS,
		proxy: PROXY,
		timeoutMs: TIMEOUT_MS,
		nodeTimeoutMs: NODE_TIMEOUT_MS,
		concurrency: CONCURRENCY,
		bulkConcurrency: BULK_CONCURRENCY,
		nodeConcurrency: NODE_CONCURRENCY,
	});

	DUMP_JSON && fs.ensureDirSync(DUMP_JSON_DIR);
	DUMP_RAW && fs.ensureDirSync(DUMP_RAW_DIR);

	const diskCache = createDownloadCache(CACHE_DIR, !!CACHE_DIR);

	const utils = {
		bulk: {
			hasNodeAtIndex(bulk, index) {
				return !(bulk.flags[index] & 8);
			},
			hasBulkMetadataAtIndex(bulk, index) {
				return !!(bulk.flags[index] & 4);
			},
			getIndexByPath(bulk, pathName) {
				let c = -1;
				for (let e = pathName, f = (e.length - 1) - ((e.length - 1) % 4); f < e.length; ++f) {
					c = bulk.childIndices[8 * (c + 1) + (e.charCodeAt(f) - 48)];
				}
				return c;
			},
			getPathByIndex(bulk, index) {
				const [first] = utils.bulk.allPaths(bulk, (i) => i === index, true);
				return first === undefined ? null : first;
			},
			allPaths(bulk, filter = () => true, stopAfterFirst = false) {
				const result = [];
				function next(oct, max) {
					if (oct.length === max) return;
					for (const nxt of [0, 1, 2, 3, 4, 5, 6, 7].map((a) => a.toString())) {
						const cur = oct + nxt;
						const i = utils.bulk.getIndexByPath(bulk, cur);
						if (i < 0) continue;
						if (filter(i)) {
							result.push(cur);
							if (stopAfterFirst) return;
						}
						next(cur, max);
					}
				}
				next("", 4);
				return result;
			},
		},

		nodeResourcePath(pathName, bulk, index) {
			const nodeEpoch = bulk.epoch[index];
			const nodeImgEpoch = bulk.imageryEpochArray ? bulk.imageryEpochArray[index] : bulk.defaultImageryEpoch;
			const nodeTexFormat = bulk.textureFormatArray ? bulk.textureFormatArray[index] : bulk.defaultTextureFormat;
			const nodeFlags = bulk.flags[index];
			const imgEpochPart = nodeFlags & 16 ? `!3u${nodeImgEpoch}` : "";
			const url = `!1m2!1s${pathName}!2u${nodeEpoch}!2e${nodeTexFormat}${imgEpochPart}!4b0`;
			return `NodeData/pb=${url}`;
		},

		async getNode(pathName, bulk, index) {
			return decode(CMD_NODE, utils.nodeResourcePath(pathName, bulk, index), true);
		},

		// Fetch the raw (still-encoded) NodeData bytes WITHOUT decoding, so the heavy
		// protobuf/mesh/texture decode can run off the main thread in a worker. Shares
		// the same disk cache and node fetch pool as getNode.
		async getNodePayload(pathName, bulk, index) {
			const resourcePath = utils.nodeResourcePath(pathName, bulk, index);
			const payload = await getUrl(`${URL_PREFIX}${resourcePath}`, true, diskCache, "node");
			return { command: CMD_NODE, payload };
		},

		async getPlanetoid() {
			return decode(CMD_BULK, "PlanetoidMetadata");
		},

		async getBulk(pathName, epoch) {
			return decode(CMD_BULK, `BulkMetadata/pb=!1m2!1s${pathName}!2u${epoch}`);
		},
	};

	const CACHE_ENABLED = true;
	const cache = {};
	const requests = {};

	async function decode(command, url, useMemoryCache = true) {
		if (useMemoryCache && CACHE_ENABLED && cache[url]) {
			return cache[url];
		}

		if (requests[url]) {
			return new Promise((resolve, reject) => {
				requests[url].push({ resolve, reject });
			});
		}

		requests[url] = [];

		let res;
		try {
			const poolKind = command === CMD_NODE ? "node" : "bulk";
			const payload = await getUrl(`${URL_PREFIX}${url}`, true, diskCache, poolKind);
			const data = await decodeResource(command, payload);
			res = data.payload;

			if (useMemoryCache && CACHE_ENABLED) {
				cache[url] = res;
			}

			const fn = url.replace("/pb=", "");
			DUMP_JSON && fs.writeFileSync(path.join(DUMP_JSON_DIR, `${fn}.json`), JSON.stringify(res, null, 2));
			DUMP_RAW && fs.writeFileSync(path.join(DUMP_RAW_DIR, `${fn}.raw`), payload);
		} catch (ex) {
			requests[url].forEach((p) => p.reject(ex));
			delete requests[url];
			throw ex;
		}

		requests[url].forEach((p) => p.resolve(res));
		delete requests[url];
		return res;
	}

	return utils;
};
