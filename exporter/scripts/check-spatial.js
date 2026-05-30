"use strict";

const fs = require("fs");
const path = require("path");

const outputDir = process.argv[2] || "./downloaded_files/regions/google_hq-L18-osgb";
const index = JSON.parse(fs.readFileSync(path.join(outputDir, ".region-osgb-index.json"), "utf8"));
const nodes = Object.entries(index.nodes || {});

const cz = [];
const cx = [];
const cy = [];
const radii = [];
for (const [, e] of nodes) {
	if (!e.bounds) continue;
	cx.push(e.bounds.cx);
	cy.push(e.bounds.cy);
	cz.push(e.bounds.cz);
	radii.push(e.bounds.radius);
}
cz.sort((a, b) => a - b);
radii.sort((a, b) => a - b);

function pct(arr, p) { return arr[Math.floor((arr.length - 1) * p)]; }
function stats(arr) {
	const min = Math.min(...arr), max = Math.max(...arr);
	const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
	return { min: +min.toFixed(1), p05: +pct(arr, 0.05).toFixed(1), p50: +pct(arr, 0.5).toFixed(1), p95: +pct(arr, 0.95).toFixed(1), max: +max.toFixed(1), mean: +mean.toFixed(1) };
}

console.log("node count with bounds:", cz.length);
console.log("cz (up) stats:", JSON.stringify(stats(cz)));
console.log("radius stats:", JSON.stringify(stats(radii)));

// Outliers in Z
const outliers = nodes.filter(([, e]) => e.bounds && Math.abs(e.bounds.cz) > 100)
	.map(([p, e]) => ({ p: p.slice(-12), cz: +e.bounds.cz.toFixed(1), r: +e.bounds.radius.toFixed(1), grid: e.gridTile }));
console.log(`\nnodes with |cz| > 100m: ${outliers.length}`);
console.log(JSON.stringify(outliers.slice(0, 15), null, 1));

// Grid tile spatial coverage: parse Tile_+XXX_+YYY indices
const tiles = new Set(nodes.map(([, e]) => e.gridTile));
const ix = [];
const iy = [];
for (const t of tiles) {
	const m = t.match(/Tile_([+-]\d+)_([+-]\d+)/);
	if (m) { ix.push(parseInt(m[1], 10)); iy.push(parseInt(m[2], 10)); }
}
ix.sort((a, b) => a - b); iy.sort((a, b) => a - b);
console.log(`\ngrid tiles: ${tiles.size}`);
console.log(`tile X index range: ${ix[0]}..${ix[ix.length - 1]} (${ix[ix.length - 1] - ix[0] + 1} cells wide)`);
console.log(`tile Y index range: ${iy[0]}..${iy[iy.length - 1]} (${iy[iy.length - 1] - iy[0] + 1} cells tall)`);
const occupancy = tiles.size / ((ix[ix.length - 1] - ix[0] + 1) * (iy[iy.length - 1] - iy[0] + 1));
console.log(`grid occupancy: ${(100 * occupancy).toFixed(1)}% (low % => scattered/gappy)`);

// ASCII occupancy map (X across, Y down). '#' = has tile, '.' = empty.
const minX = ix[0], maxX = ix[ix.length - 1], minY = iy[0], maxY = iy[iy.length - 1];
const occ = new Set([...tiles].map((t) => {
	const m = t.match(/Tile_([+-]\d+)_([+-]\d+)/);
	return m ? `${parseInt(m[1], 10)},${parseInt(m[2], 10)}` : "";
}));
console.log("\noccupancy map (each cell = 80m; X->, Y down):");
for (let y = maxY; y >= minY; y--) {
	let row = "";
	for (let x = minX; x <= maxX; x++) row += occ.has(`${x},${y}`) ? "#" : ".";
	console.log(row);
}
