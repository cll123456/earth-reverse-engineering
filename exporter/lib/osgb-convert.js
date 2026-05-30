"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");

function findOsgConv() {
	const candidates = process.platform === "win32"
		? ["osgconv.exe", "osgconv"]
		: ["osgconv"];

	for (const cmd of candidates) {
		const result = spawnSync(cmd, ["--help"], { stdio: "ignore" });
		if (!result.error) return cmd;
	}
	return null;
}

const OSGCONV_INLINE_TEXTURES = ["-O", "WriteOutInlineImages=true"];

function osgConvArgs(input, output) {
	return [...OSGCONV_INLINE_TEXTURES, input, output];
}

function convertTileDirectory(dataDir, tileName, osgConvPath) {
	const tileDir = path.join(dataDir, tileName);
	const objPath = path.join(tileDir, `${tileName}.obj`);
	const osgbPath = path.join(tileDir, `${tileName}.osgb`);

	if (!fs.existsSync(objPath)) {
		return { tileName, status: "missing_obj" };
	}

	const objText = fs.readFileSync(objPath, "utf8");
	if (!/\nv /.test(objText)) {
		return { tileName, status: "empty_obj" };
	}

	const result = spawnSync(osgConvPath, osgConvArgs(objPath, osgbPath), {
		cwd: tileDir,
		stdio: "pipe",
		encoding: "utf8",
	});

	if (result.status !== 0 || !fs.existsSync(osgbPath)) {
		return {
			tileName,
			status: "failed",
			error: result.stderr || result.stdout || "osgconv failed",
		};
	}

	return { tileName, status: "converted", osgbPath };
}

function convertAllTiles(outputDir) {
	const dataDir = path.join(outputDir, "Data");
	if (!fs.existsSync(dataDir)) {
		return { converted: 0, failed: 0, skipped: 0, osgConvAvailable: false, details: [] };
	}

	const osgConvPath = findOsgConv();
	if (!osgConvPath) {
		return {
			converted: 0,
			failed: 0,
			skipped: fs.readdirSync(dataDir).filter((name) => fs.statSync(path.join(dataDir, name)).isDirectory()).length,
			osgConvAvailable: false,
			details: [],
			message: "osgconv not found. Install OpenSceneGraph and ensure osgconv is on PATH.",
		};
	}

	const tileDirs = fs.readdirSync(dataDir).filter((name) => fs.statSync(path.join(dataDir, name)).isDirectory());
	const details = [];
	let converted = 0;
	let failed = 0;
	let skipped = 0;

	for (const tileName of tileDirs) {
		const osgbPath = path.join(dataDir, tileName, `${tileName}.osgb`);
		if (fs.existsSync(osgbPath)) {
			skipped++;
			details.push({ tileName, status: "already_exists" });
			continue;
		}
		const result = convertTileDirectory(dataDir, tileName, osgConvPath);
		details.push(result);
		if (result.status === "converted") converted++;
		else if (result.status === "empty_obj" || result.status === "missing_obj") skipped++;
		else failed++;
	}

	return {
		converted,
		failed,
		skipped,
		osgConvAvailable: true,
		osgConvPath,
		details,
	};
}

module.exports = {
	findOsgConv,
	OSGCONV_INLINE_TEXTURES,
	osgConvArgs,
	convertAllTiles,
};
