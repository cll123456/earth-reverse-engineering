"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./osgb-convert");
const { sanitizeConvertedOsgb } = require("./osgb-sanitize");

function createOsgbConvertPool({ concurrency = 4 } = {}) {
	const osgConvPath = findOsgConv();
	if (!osgConvPath) {
		throw new Error("osgconv not found. Install OpenSceneGraph and ensure osgconv is on PATH.");
	}

	const queue = [];
	let active = 0;
	let converted = 0;
	let failed = 0;
	let sanitized = 0;
	let drainWaiters = [];

	function maybeDrain() {
		if (queue.length === 0 && active === 0) {
			for (const resolve of drainWaiters.splice(0)) resolve();
		}
	}

	function finishJob(job, error = null) {
		active--;
		const cleanup = () => {
			if (job.tempDir) {
				fs.remove(job.tempDir).catch(() => {});
			}
		};
		if (error) {
			failed++;
			cleanup();
			job.reject(error);
		} else {
			converted++;
			cleanup();
			job.resolve();
		}
		runNext();
		maybeDrain();
	}

	function validateConvertedOsgb(job) {
		if (!job.outputPath || !fs.existsSync(job.outputPath)) {
			finishJob(job, new Error("osgconv produced no output file"));
			return;
		}
		try {
			const result = sanitizeConvertedOsgb({
				outputPath: job.outputPath,
				workDir: job.workDir,
				inputName: job.inputName,
				reconvertOnInvalid: true,
			});
			if (result.reconverted) sanitized++;
			if (!result.ok && result.validation?.reason) {
				finishJob(job, new Error(`OSGB validation failed (${result.validation.reason})`));
				return;
			}
			finishJob(job);
		} catch (error) {
			finishJob(job, error);
		}
	}

	function runNext() {
		while (active < concurrency && queue.length > 0) {
			const job = queue.shift();
			active++;
			const outputArg = path.isAbsolute(job.outputPath)
				? job.outputPath
				: path.join(job.workDir, job.outputPath);
			const proc = spawn(osgConvPath, [...OSGCONV_INLINE_TEXTURES, job.inputName, outputArg], {
				cwd: job.workDir,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			proc.on("close", (code) => {
				if (code !== 0 || !fs.existsSync(job.outputPath)) {
					finishJob(job, new Error(stderr.trim() || `osgconv exited ${code}`));
					return;
				}
				validateConvertedOsgb(job);
			});
			proc.on("error", (error) => {
				finishJob(job, error);
			});
		}
	}

	function enqueue({ workDir, inputName, outputPath, tempDir = null }) {
		return new Promise((resolve, reject) => {
			queue.push({
				workDir,
				inputName,
				outputPath,
				tempDir,
				resolve,
				reject,
			});
			runNext();
		});
	}

	function drain() {
		if (queue.length === 0 && active === 0) return Promise.resolve();
		return new Promise((resolve) => {
			drainWaiters.push(resolve);
			maybeDrain();
		});
	}

	return {
		enqueue,
		drain,
		get converted() { return converted; },
		get failed() { return failed; },
		get sanitized() { return sanitized; },
		get pending() { return queue.length + active; },
		get concurrency() { return concurrency; },
	};
}

module.exports = {
	createOsgbConvertPool,
};
