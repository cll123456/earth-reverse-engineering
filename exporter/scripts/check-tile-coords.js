"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const osg = "D:/Program Files/iFreedo_Desktop/osgconv.exe";
const outputDir = process.argv[2] || "./downloaded_files/regions/google_hq-L22-osgb";
const base = path.join(outputDir, "Data");
const idx = JSON.parse(fs.readFileSync(path.join(outputDir, ".region-osgb-index.json"), "utf8"));

function rootBounds(tile) {
	const p = path.join(base, tile, `${tile}.osgb`);
	if (!fs.existsSync(p)) return null;
	const t = path.join(base, tile, "_tmp.osgt");
	spawnSync(osg, [p, t], { stdio: "pipe" });
	const text = fs.readFileSync(t, "utf8");
	fs.unlinkSync(t);
	const verts = [];
	for (const m of text.matchAll(/Vec3Array[\s\S]*?vector \d+\s*\{([^}]+)\}/g)) {
		const nums = m[1].trim().split(/\s+/).map(Number);
		for (let i = 0; i + 2 < nums.length; i += 3) verts.push([nums[i], nums[i + 1], nums[i + 2]]);
	}
	let min = [Infinity, Infinity, Infinity];
	let max = [-Infinity, -Infinity, -Infinity];
	for (const [x, y, z] of verts) {
		min[0] = Math.min(min[0], x);
		min[1] = Math.min(min[1], y);
		min[2] = Math.min(min[2], z);
		max[0] = Math.max(max[0], x);
		max[1] = Math.max(max[1], y);
		max[2] = Math.max(max[2], z);
	}
	return {
		verts: verts.length,
		min,
		max,
		cx: (min[0] + max[0]) / 2,
		cy: (min[1] + max[1]) / 2,
	};
}

const byGrid = {};
for (const entry of Object.values(idx.nodes || {})) {
	const g = entry.gridTile;
	if (!byGrid[g]) byGrid[g] = { count: 0, cx: [], cy: [] };
	byGrid[g].count++;
	if (entry.bounds) {
		byGrid[g].cx.push(entry.bounds.cx);
		byGrid[g].cy.push(entry.bounds.cy);
	}
}

const tiles = fs.readdirSync(base).filter((n) => n.startsWith("Tile_")).sort();
console.log("tile count:", tiles.length);
for (const t of tiles) {
	const m = /^Tile_\+(\d{3})_\+(\d{3})$/.exec(t);
	const col = parseInt(m[1], 10);
	const row = parseInt(m[2], 10);
	const b = rootBounds(t);
	const g = byGrid[t];
	const avgCx = g?.cx.length ? g.cx.reduce((a, v) => a + v, 0) / g.cx.length : NaN;
	const avgCy = g?.cy.length ? g.cy.reduce((a, v) => a + v, 0) / g.cy.length : NaN;
	console.log(
		`${t} grid=(${col},${row}) nodes=${g?.count || 0}`
		+ ` rootCenter=(${b ? b.cx.toFixed(1) : "n/a"},${b ? b.cy.toFixed(1) : "n/a"})`
		+ ` indexAvg=(${avgCx.toFixed(1)},${avgCy.toFixed(1)})`
		+ ` rootMax=(${b ? b.max[0].toFixed(1) : "n/a"},${b ? b.max[1].toFixed(1) : "n/a"})`
		+ ` rootVerts=${b?.verts || 0}`,
	);
}
