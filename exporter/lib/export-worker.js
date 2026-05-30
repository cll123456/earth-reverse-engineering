"use strict";

const { parentPort } = require("worker_threads");
const { writeTileNode } = require("./export-tile");

parentPort.on("message", (job) => {
	try {
		const result = writeTileNode(job);
		parentPort.postMessage({
			ok: true,
			pathName: job.pathName,
			wroteAny: result.wroteAny,
			tileName: result.tileName,
		});
	} catch (error) {
		parentPort.postMessage({
			ok: false,
			pathName: job.pathName,
			error: error.message || String(error),
		});
	}
});
