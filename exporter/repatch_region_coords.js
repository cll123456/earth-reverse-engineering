"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const bmp = require("bmp-js");
const { bmpBufferToPng } = require("./lib/texture-export");

const outputDir = path.resolve(process.argv[2] || "./downloaded_files/regions/google_hq-L22-v2");
const dataDir = path.join(outputDir, "Data");

function repatchObjLine(line) {
	// Convert legacy Y-up export (X=east,Y=up,Z=-north) to DasViewer Z-up ENU.
	if (line.startsWith("v ")) {
		const parts = line.split(/\s+/);
		if (parts.length >= 4) {
			const x = parseFloat(parts[1]);
			const y = parseFloat(parts[2]);
			const z = parseFloat(parts[3]);
			return `v ${x} ${-z} ${y}`;
		}
	}
	if (line.startsWith("vn ")) {
		const parts = line.split(/\s+/);
		if (parts.length >= 4) {
			const x = parseFloat(parts[1]);
			const y = parseFloat(parts[2]);
			const z = parseFloat(parts[3]);
			return `vn ${x} ${-z} ${y}`;
		}
	}
	return line;
}

function repatchMtl(mtlText) {
	return mtlText
		.replace(/map_Kd\s+(\S+)\.bmp/g, "map_Kd $1.png")
		.split("\n")
		.map((line) => line)
		.join("\n");
}

function convertBmpTextures(tileDir, tileName) {
	const mtlPath = path.join(tileDir, `${tileName}.mtl`);
	if (!fs.existsSync(mtlPath)) return;
	const mtl = fs.readFileSync(mtlPath, "utf8");
	const maps = [...mtl.matchAll(/map_Kd\s+(\S+)\.(bmp|png|jpg)/g)];
	for (const [, baseName, ext] of maps) {
		const bmpPath = path.join(tileDir, `${baseName}.bmp`);
		const pngPath = path.join(tileDir, `${baseName}.png`);
		if (ext === "bmp" && fs.existsSync(bmpPath) && !fs.existsSync(pngPath)) {
			const png = bmpBufferToPng(fs.readFileSync(bmpPath));
			fs.writeFileSync(pngPath, png);
		}
	}
	fs.writeFileSync(mtlPath, repatchMtl(mtl));
}

function repatchTile(tileDir, tileName) {
	const objPath = path.join(tileDir, `${tileName}.obj`);
	if (!fs.existsSync(objPath)) return { tileName, status: "missing_obj" };
	const text = fs.readFileSync(objPath, "utf8");
	if (!/\nv /.test(text)) return { tileName, status: "empty_obj" };

	const repatched = text.split("\n").map(repatchObjLine).join("\n");
	fs.writeFileSync(objPath, repatched);
	convertBmpTextures(tileDir, tileName);

	const osgbPath = path.join(tileDir, `${tileName}.osgb`);
	if (fs.existsSync(osgbPath)) fs.removeSync(osgbPath);

	const result = spawnSync("osgconv", [objPath, osgbPath], {
		cwd: tileDir,
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0 || !fs.existsSync(osgbPath)) {
		return { tileName, status: "osgb_failed", error: result.stderr || result.stdout };
	}
	return { tileName, status: "repatched" };
}

if (!fs.existsSync(dataDir)) {
	console.error("Data directory not found:", dataDir);
	process.exit(1);
}

const tiles = fs.readdirSync(dataDir).filter((name) => fs.statSync(path.join(dataDir, name)).isDirectory());
const results = tiles.map((tileName) => repatchTile(path.join(dataDir, tileName), tileName));
const summary = {
	repatched: results.filter((r) => r.status === "repatched").length,
	failed: results.filter((r) => r.status === "osgb_failed").length,
	skipped: results.filter((r) => r.status === "empty_obj" || r.status === "missing_obj").length,
};
console.log(JSON.stringify({ outputDir, ...summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;
