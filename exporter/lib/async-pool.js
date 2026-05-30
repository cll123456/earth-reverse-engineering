"use strict";

const os = require("os");

function getDefaultConcurrency() {
	return Math.max(2, (os.cpus() || []).length);
}

function createAsyncPool(concurrency) {
	const limit = Math.max(1, concurrency);
	let active = 0;
	const queue = [];

	function pump() {
		while (active < limit && queue.length > 0) {
			active++;
			const { fn, resolve, reject } = queue.shift();
			Promise.resolve()
				.then(fn)
				.then(resolve, reject)
				.finally(() => {
					active--;
					pump();
				});
		}
	}

	function run(fn) {
		return new Promise((resolve, reject) => {
			queue.push({ fn, resolve, reject });
			pump();
		});
	}

	async function drain() {
		while (active > 0 || queue.length > 0) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	function getStats() {
		return { active, queued: queue.length, pending: active + queue.length };
	}

	async function map(items, fn) {
		return Promise.all(items.map((item, index) => run(() => fn(item, index))));
	}

	return { run, map, drain, getStats, concurrency: limit };
}

module.exports = {
	getDefaultConcurrency,
	createAsyncPool,
};
