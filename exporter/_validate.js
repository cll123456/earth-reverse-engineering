// Validate a densified pyramid output by walking the actual PagedLOD file-reference graph:
// every .osgb under Data/ must round-trip through osgconv (i.e. parse), and every external
// child file it references must exist in the same directory. Catches dangling references
// and corrupt files regardless of whether the layout is one-file-per-node or LOD-bundled.
//
//   node _validate.js <regionDir>
const path = require("path");
const fs = require("fs-extra");
const { spawnSync } = require("child_process");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./lib/osgb-convert");

const regionDir = process.argv[2];
const dataDir = path.join(regionDir, "Data");
const osgconv = findOsgConv();
if (!osgconv) { console.error("osgconv not found"); process.exit(2); }

function listOsgb(dir) {
	const out = [];
	for (const tile of fs.readdirSync(dir)) {
		const td = path.join(dir, tile);
		if (!fs.statSync(td).isDirectory()) continue;
		for (const f of fs.readdirSync(td)) if (f.endsWith(".osgb")) out.push({ tile, td, file: f });
	}
	return out;
}

const files = listOsgb(dataDir);
let parseFail = 0, dangling = 0, refs = 0;
const tmp = path.join(dataDir, "_validate_tmp.osgt");
for (const { td, file } of files) {
	const r = spawnSync(osgconv, [...OSGCONV_INLINE_TEXTURES, file, path.resolve(tmp)], { cwd: td, encoding: "utf8" });
	if (r.status !== 0 || !fs.existsSync(tmp)) {
		parseFail++; if (parseFail <= 5) console.log("PARSE FAIL:", file, (r.stderr || "").trim().split("\n")[0]);
		continue;
	}
	const text = fs.readFileSync(tmp, "utf8");
	fs.removeSync(tmp);
	for (const m of text.matchAll(/"([^"]+\.osgb)"/g)) {
		refs++;
		if (!fs.existsSync(path.join(td, m[1]))) { dangling++; if (dangling <= 10) console.log("DANGLING:", file, "->", m[1]); }
	}
}

console.log("\n--- summary ---");
console.log("osgb files:", files.length, "external refs:", refs);
console.log("parseFail:", parseFail, "dangling:", dangling);
console.log(parseFail + dangling === 0 ? "OK: all files parse, no dangling references" : "PROBLEMS FOUND");
