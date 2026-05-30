"use strict";

const os = require("os");

function defaultConcurrency() {
	return Math.max(2, (os.cpus() || []).length);
}

function parseConcurrency(value) {
	if (value === undefined || value === null || value === "auto") {
		return defaultConcurrency();
	}
	const n = parseInt(value, 10);
	if (!Number.isInteger(n) || n < 1 || n > 64) {
		throw new Error(`concurrency must be 1-64 or auto, got ${value}`);
	}
	return n;
}

function createLimiter(concurrency) {
	let active = 0;
	const queue = [];

	function drain() {
		while (active < concurrency && queue.length > 0) {
			active++;
			const { fn, resolve, reject } = queue.shift();
			Promise.resolve()
				.then(fn)
				.then(resolve, reject)
				.finally(() => {
					active--;
					drain();
				});
		}
	}

	return function limit(fn) {
		return new Promise((resolve, reject) => {
			queue.push({ fn, resolve, reject });
			drain();
		});
	};
}

module.exports = {
	defaultConcurrency,
	parseConcurrency,
	createLimiter,
};
