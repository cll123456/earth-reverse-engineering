"use strict";

const { Worker } = require("worker_threads");

const path = require("path");

function createWorkerPool(workerScript, size) {
	const workerPath = path.resolve(workerScript);
	const workers = [];
	const waitQueue = [];

	function attachWorker(slot) {
		const worker = new Worker(workerPath);
		worker.on("message", (message) => {
			if (!slot.pending) return;
			const { resolve, reject } = slot.pending;
			slot.pending = null;
			slot.busy = false;
			if (message.ok) resolve(message);
			else reject(new Error(message.error || "worker failed"));
			pump();
		});
		worker.on("error", (error) => {
			if (!slot.pending) return;
			const { reject } = slot.pending;
			slot.pending = null;
			slot.busy = false;
			reject(error);
			pump();
		});
		worker.on("exit", (code) => {
			if (code !== 0 && slot.pending) {
				const { reject } = slot.pending;
				slot.pending = null;
				slot.busy = false;
				reject(new Error(`worker exited with code ${code}`));
				pump();
			}
		});
		slot.worker = worker;
	}

	for (let i = 0; i < Math.max(1, size); i++) {
		const slot = { busy: false, pending: null, worker: null };
		attachWorker(slot);
		workers.push(slot);
	}

	function pump() {
		while (waitQueue.length > 0) {
			const slot = workers.find((entry) => !entry.busy);
			if (!slot) break;
			const task = waitQueue.shift();
			slot.busy = true;
			slot.pending = task;
			slot.worker.postMessage(task.job);
		}
	}

	function run(job) {
		return new Promise((resolve, reject) => {
			waitQueue.push({ job, resolve, reject });
			pump();
		});
	}

	async function destroy() {
		await Promise.all(workers.map((slot) => slot.worker.terminate()));
	}

	return { run, destroy, size: workers.length };
}

module.exports = {
	createWorkerPool,
};
