"use strict";

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { loadIndex, indexPath } = require("./osgb-stream-writer");

function createDownloadCache(cacheDir, enabled) {
	if (!enabled) {
		return {
			enabled: false,
			async read() { return null; },
			async write() {},
		};
	}

	fs.ensureDirSync(cacheDir);

	function cachePath(url) {
		const hash = crypto.createHash("sha1").update(url).digest("hex");
		return path.join(cacheDir, `${hash}.bin`);
	}

	return {
		enabled: true,
		cacheDir,
		async read(url) {
			const filePath = cachePath(url);
			if (await fs.pathExists(filePath)) {
				return fs.readFile(filePath);
			}
			return null;
		},
		async write(url, payload) {
			await fs.writeFile(cachePath(url), payload);
		},
	};
}

function tileObjPath(outputDir, pathName) {
	const tileName = `Tile_${pathName}`;
	return path.join(outputDir, "Data", tileName, `${tileName}.obj`);
}

function stagingNodeObjPath(outputDir, pathName) {
	return path.join(outputDir, ".staging", "nodes", pathName, "node.obj");
}

const COORD_VERSION = 2;

function createProgressTracker(progressFile, outputDir, { tileGroupLevel = null, exportMode = "tiles" } = {}) {
	const completedSet = new Set();
	let saveTimer = null;
	let dirty = false;
	const mergedTiles = tileGroupLevel != null && tileGroupLevel > 0;

	async function load() {
		if (await fs.pathExists(progressFile)) {
			const state = await fs.readJson(progressFile);
			if (exportMode === "osgb" && state.coordVersion !== COORD_VERSION) {
				console.warn(
					`Progress coord version ${state.coordVersion || 1} -> ${COORD_VERSION}; `
					+ "rebuilding OSGB coordinates (HTTP cache kept).",
				);
				const idxFile = indexPath(outputDir);
				if (await fs.pathExists(idxFile)) {
					await fs.writeJson(idxFile, { nodes: {}, childMap: {} }, { spaces: 2 });
				}
			} else {
				for (const pathName of state.completedNodes || []) {
					completedSet.add(pathName);
				}
			}
		}
	}

	async function scanDiskExports() {
		const onDisk = new Set();
		if (exportMode === "osgb") {
			const idx = await loadIndex(outputDir);
			for (const pathName of Object.keys(idx.nodes || {})) {
				onDisk.add(pathName);
			}
			return onDisk;
		}

		const dataDir = path.join(outputDir, "Data");
		if (!await fs.pathExists(dataDir)) return onDisk;

		const entries = await fs.readdir(dataDir);
		for (const entry of entries) {
			if (!entry.startsWith("Tile_")) continue;
			const pathName = entry.slice(5);
			if (await fs.pathExists(tileObjPath(outputDir, pathName))) {
				onDisk.add(pathName);
			}
		}
		return onDisk;
	}

	async function save() {
		await fs.ensureDir(path.dirname(progressFile));
		await fs.writeJson(progressFile, {
			coordVersion: COORD_VERSION,
			completedNodes: [...completedSet].sort(),
			updatedAt: new Date().toISOString(),
		}, { spaces: 2 });
		dirty = false;
	}

	async function flush() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		if (dirty) await save();
	}

	return {
		async init() {
			await load();
			const onDisk = await scanDiskExports();
			const before = completedSet.size;

			if (mergedTiles || exportMode === "osgb") {
				// Merged/OSGB export: progress tracks leaf nodes; disk uses staging or group keys.
				// Keep progress file as source of truth for resume.
			} else {
				for (const pathName of onDisk) {
					completedSet.add(pathName);
				}
				for (const pathName of [...completedSet]) {
					if (!onDisk.has(pathName)) {
						completedSet.delete(pathName);
					}
				}
			}

			if (!mergedTiles && (completedSet.size !== before || dirty)) {
				await save();
			}

			return {
				onDisk: onDisk.size,
				mergedTiles,
				progressBefore: before,
				progressAfter: completedSet.size,
			};
		},
		isExported(pathName) {
			return completedSet.has(pathName);
		},
		hasCompleted(pathName) {
			return completedSet.has(pathName);
		},
		async markCompleted(pathName) {
			if (completedSet.has(pathName)) return;
			completedSet.add(pathName);
			dirty = true;
			if (!saveTimer) {
				saveTimer = setTimeout(async () => {
					saveTimer = null;
					await save();
				}, 1500);
			}
		},
		flush,
		getState() {
			return { completedNodes: [...completedSet] };
		},
	};
}

module.exports = {
	createDownloadCache,
	createProgressTracker,
	tileObjPath,
	stagingNodeObjPath,
	indexPath,
};
