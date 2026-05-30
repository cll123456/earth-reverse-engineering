"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const osg = process.env.OSGCONV || "D:/Program Files/iFreedo_Desktop/osgconv.exe";

function analyzeOsgt(osgbPath) {
	const dir = path.dirname(osgbPath);
	const baseName = path.basename(osgbPath, ".osgb");
	const osgt = path.join(dir, `${baseName}_cmp.osgt`);
	spawnSync(osg, [osgbPath, osgt], { stdio: "pipe" });
	const text = fs.readFileSync(osgt, "utf8");
	fs.unlinkSync(osgt);
	const arrays = [...text.matchAll(/Vec3Array[\s\S]*?vector (\d+)\s*\{([^}]+)\}/g)].map((m) => {
		const nums = m[2].trim().split(/\s+/).map(Number);
		let min = [Infinity, Infinity, Infinity];
		let max = [-Infinity, -Infinity, -Infinity];
		for (let j = 0; j + 2 < nums.length; j += 3) {
			min[0] = Math.min(min[0], nums[j]);
			max[0] = Math.max(max[0], nums[j]);
			min[1] = Math.min(min[1], nums[j + 1]);
			max[1] = Math.max(max[1], nums[j + 1]);
			min[2] = Math.min(min[2], nums[j + 2]);
			max[2] = Math.max(max[2], nums[j + 2]);
		}
		return { count: parseInt(m[1], 10), min, max };
	});
	const userCenters = [...text.matchAll(/UserCenter ([^\n]+)/g)].map((m) => m[1].trim());
	return { arrays, userCenters };
}

function compareRegion(label, outputDir) {
	console.log(`\n======== ${label} ========`);
	const meta = fs.readFileSync(path.join(outputDir, "metadata.xml"), "utf8");
	const srs = meta.match(/<SRS>([^<]+)/)?.[1];
	const origin = meta.match(/<SRSOrigin>([^<]+)/)?.[1];
	console.log("SRS:", srs, "SRSOrigin:", origin);
	const base = path.join(outputDir, "Data");
	const tiles = fs.readdirSync(base).filter((n) => n.startsWith("Tile_")).sort();
	console.log("tile count:", tiles.length);
	for (const tile of tiles.slice(0, 4)) {
		const root = path.join(base, tile, `${tile}.osgb`);
		if (!fs.existsSync(root)) continue;
		const info = analyzeOsgt(root);
		console.log(`\n${tile} root:`);
		console.log("  Vec3Arrays:", info.arrays.length);
		for (const [i, a] of info.arrays.entries()) {
			console.log(`  [${i}] n=${a.count} min=${a.min.map((v) => v.toFixed(1)).join(",")} max=${a.max.map((v) => v.toFixed(1)).join(",")}`);
		}
		console.log("  UserCenter:", info.userCenters);
		const leaf = fs.readdirSync(path.join(base, tile))
			.filter((f) => f.includes("_L2") && f.endsWith(".osgb") && fs.statSync(path.join(base, tile, f)).size > 5000)
			.sort((a, b) => fs.statSync(path.join(base, tile, b)).size - fs.statSync(path.join(base, tile, a)).size)[0];
		if (leaf) {
			const leafInfo = analyzeOsgt(path.join(base, tile, leaf));
			console.log(`  leaf ${leaf}:`);
			console.log("  Vec3Arrays:", leafInfo.arrays.length);
			for (const [i, a] of leafInfo.arrays.entries()) {
				console.log(`  [${i}] n=${a.count} min=${a.min.map((v) => v.toFixed(1)).join(",")} max=${a.max.map((v) => v.toFixed(1)).join(",")}`);
			}
		}
	}
}

compareRegion("OUR", process.argv[2] || "./downloaded_files/regions/google_hq-L22-osgb");
compareRegion("REF", process.argv[3] || "F:/零时/Production_1/Production_1");
