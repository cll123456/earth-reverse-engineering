"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const { getTileGroupKey } = require("./lib/tile-group");
const { mergeTileGroup } = require("./lib/obj-merge");
const { convertAllTiles, findOsgConv } = require("./lib/osgb-convert");

async function mergeRegionTiles(outputDir, tileGroupLevel, { convertOsgb = true } = {}) {
	const dataDir = path.join(outputDir, "Data");
	const mergedDir = path.join(outputDir, "Data_merged");
	if (!await fs.pathExists(dataDir)) {
		throw new Error(`Data directory not found: ${dataDir}`);
	}

	const tileDirs = (await fs.readdir(dataDir))
		.filter((name) => name.startsWith("Tile_"))
		.map((name) => path.join(dataDir, name))
		.filter((dir) => fs.statSync(dir).isDirectory());

	const groups = new Map();
	for (const tileDir of tileDirs) {
		const pathName = path.basename(tileDir).slice(5);
		const groupKey = getTileGroupKey(pathName, tileGroupLevel);
		const groupName = `Tile_${groupKey}`;
		if (!groups.has(groupName)) groups.set(groupName, []);
		groups.get(groupName).push(tileDir);
	}

	await fs.remove(mergedDir);
	await fs.ensureDir(mergedDir);

	const results = [];
	for (const [groupName, members] of groups.entries()) {
		if (members.length === 1) {
			const targetDir = path.join(mergedDir, groupName);
			await fs.copy(members[0], targetDir);
			results.push({ groupName, status: "copied", sourceCount: 1 });
			continue;
		}
		const result = await mergeTileGroup(members, path.join(mergedDir, groupName), groupName);
		results.push({ groupName, ...result, sourceCount: members.length });
	}

	let osgbResult = null;
	if (convertOsgb && findOsgConv()) {
		const backupDir = path.join(outputDir, "Data_unmerged_backup");
		if (await fs.pathExists(backupDir)) await fs.remove(backupDir);
		await fs.move(dataDir, backupDir);
		await fs.move(mergedDir, dataDir);
		osgbResult = convertAllTiles(outputDir);
	} else {
		console.log("Merged tiles written to:", mergedDir);
		console.log("Original tiles kept in:", dataDir);
	}

	return {
		outputDir,
		tileGroupLevel,
		sourceTiles: tileDirs.length,
		mergedTiles: groups.size,
		groupsMerged: results.filter((r) => r.status === "merged").length,
		osgb: osgbResult,
	};
}

async function main() {
	const outputDir = path.resolve(process.argv[2] || "./downloaded_files/regions/google_hq-L22-v4");
	const tileGroupLevel = parseInt(process.argv[3] || "18", 10);
	const convertOsgb = !process.argv.includes("--no-osgb");
	const summary = await mergeRegionTiles(outputDir, tileGroupLevel, { convertOsgb });
	console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

module.exports = {
	mergeRegionTiles,
};
