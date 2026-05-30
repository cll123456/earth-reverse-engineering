"use strict";

const fs = require("fs");
const path = require("path");
const idx = JSON.parse(fs.readFileSync("./downloaded_files/regions/google_hq-L22-osgb/.region-osgb-index.json", "utf8"));

function objBounds(objPath) {
	const text = fs.readFileSync(objPath, "utf8");
	let min = [Infinity, Infinity, Infinity];
	let max = [-Infinity, -Infinity, -Infinity];
	let nearOrigin = 0;
	let total = 0;
	for (const line of text.split("\n")) {
		if (!line.startsWith("v ")) continue;
		const [, xs, ys, zs] = line.trim().split(/\s+/);
		const x = parseFloat(xs);
		const y = parseFloat(ys);
		const z = parseFloat(zs);
		total++;
		min[0] = Math.min(min[0], x);
		min[1] = Math.min(min[1], y);
		min[2] = Math.min(min[2], z);
		max[0] = Math.max(max[0], x);
		max[1] = Math.max(max[1], y);
		max[2] = Math.max(max[2], z);
		if (Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(z) < 1) nearOrigin++;
	}
	return { total, min, max, nearOrigin };
}

// Sample a few paths from different grid tiles
const samples = [
	"3140504173706240404044",
	"3140504173617352735511",
	"3140504173706240537153",
];
for (const pn of samples) {
	const entry = idx.nodes[pn];
	console.log(pn, entry?.gridTile, entry?.bounds);
}

// Check if any cached temp - instead read a leaf osgb vs check index bounds distribution
const byTile = {};
for (const [pn, e] of Object.entries(idx.nodes)) {
	if (pn.length !== 22) continue;
	const g = e.gridTile;
	if (!byTile[g]) byTile[g] = [];
	byTile[g].push(e.bounds);
}
for (const [g, bounds] of Object.entries(byTile).slice(0, 5)) {
	const minCx = Math.min(...bounds.map((b) => b.cx));
	const maxCx = Math.max(...bounds.map((b) => b.cx));
	const minCy = Math.min(...bounds.map((b) => b.cy));
	const maxCy = Math.max(...bounds.map((b) => b.cy));
	console.log(g, "L22 cx range", minCx.toFixed(1), maxCx.toFixed(1), "cy range", minCy.toFixed(1), maxCy.toFixed(1), "count", bounds.length);
}

// Count nodes with bounds near origin
let nearOriginNodes = 0;
for (const e of Object.values(idx.nodes)) {
	if (!e.bounds) continue;
	if (Math.abs(e.bounds.cx) < 5 && Math.abs(e.bounds.cy) < 5) nearOriginNodes++;
}
console.log("nodes with bounds center near origin:", nearOriginNodes, "/", Object.keys(idx.nodes).length);
