"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { readOsgbVertexBounds } = require("../lib/osgb-vertex-bounds");

const osg = "D:/Program Files/iFreedo_Desktop/osgconv.exe";
const outputDir = process.argv[2] || "./downloaded_files/regions/google_hq-L22-osgb";
const base = path.join(outputDir, "Data");

function analyzeOsgb(osgbPath) {
	const bounds = readOsgbVertexBounds(osgbPath, osg);
	if (!bounds) {
		return { file: path.basename(osgbPath), verts: 0, min: [0, 0, 0], max: [0, 0, 0], span: [0, 0, 0], centers: [], children: [] };
	}
	const textPath = osgbPath.replace(/\.osgb$/, "_meta.osgt");
	spawnSync(osg, [osgbPath, textPath], { stdio: "pipe" });
	const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8") : "";
	if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
	const centers = [...text.matchAll(/UserCenter ([^\n]+)/g)].map((m) => m[1].trim());
	const children = [...text.matchAll(/RangeDataList \d+\s*\{([^}]+)\}/g)].map((m) => m[1].trim());
	return {
		file: path.basename(osgbPath),
		verts: bounds.vertexCount,
		min: [bounds.minX, bounds.minY, bounds.minZ],
		max: [bounds.maxX, bounds.maxY, bounds.maxZ],
		span: [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ],
		centers,
		children,
	};
}

const tiles = fs.readdirSync(base).filter((n) => n.startsWith("Tile_"));
console.log("metadata:", fs.readFileSync(path.join(outputDir, "metadata.xml"), "utf8").trim());

for (const tile of tiles.slice(0, 3)) {
	const dir = path.join(base, tile);
	const root = path.join(dir, `${tile}.osgb`);
	console.log(`\n=== ${tile} root ===`);
	console.log(JSON.stringify(analyzeOsgb(root), null, 2));
	const leaves = fs.readdirSync(dir)
		.filter((f) => f.includes("_L22_") && f.endsWith(".osgb") && fs.statSync(path.join(dir, f)).size > 5000)
		.slice(0, 1);
	if (leaves[0]) {
		console.log(`=== ${tile} leaf ${leaves[0]} ===`);
		console.log(JSON.stringify(analyzeOsgb(path.join(dir, leaves[0])), null, 2));
	}
}

const idxPath = path.join(outputDir, ".region-osgb-index.json");
if (fs.existsSync(idxPath)) {
	const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
	const entries = Object.entries(idx.nodes);
	let globalMin = [Infinity, Infinity, Infinity];
	let globalMax = [-Infinity, -Infinity, -Infinity];
	for (const [, v] of entries) {
		const b = v.bounds;
		if (!b) continue;
		globalMin[0] = Math.min(globalMin[0], b.cx - b.radius);
		globalMax[0] = Math.max(globalMax[0], b.cx + b.radius);
		globalMin[1] = Math.min(globalMin[1], b.cy - b.radius);
		globalMax[1] = Math.max(globalMax[1], b.cy + b.radius);
		globalMin[2] = Math.min(globalMin[2], b.cz - b.radius);
		globalMax[2] = Math.max(globalMax[2], b.cz + b.radius);
	}
	console.log("\nindex node count:", entries.length);
	console.log("index bounds envelope:", { min: globalMin, max: globalMax, span: globalMax.map((v, i) => v - globalMin[i]) });
	console.log("sample index bounds:", entries.slice(0, 2).map(([k, v]) => ({ path: k.slice(-12), bounds: v.bounds, grid: v.gridTile })));
}
