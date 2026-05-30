"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const osg = "D:/Program Files/iFreedo_Desktop/osgconv.exe";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osgtest-"));
const obj = [
	"mtllib t.mtl",
	"o test",
	"v -1000 50 -500",
	"v -990 50 -500",
	"v -1000 51 -500",
	"vn 0 1 0",
	"vt 0 0",
	"usemtl m",
	"f 1/1/1 2/1/1 3/1/1",
	"",
].join("\n");
fs.writeFileSync(path.join(dir, "t.obj"), obj);
fs.writeFileSync(path.join(dir, "t.mtl"), "newmtl m\nKd 1 1 1\n");
spawnSync(osg, ["t.obj", "t.osgb"], { cwd: dir, stdio: "pipe" });
spawnSync(osg, ["t.osgb", "t.osgt"], { cwd: dir, stdio: "pipe" });
const text = fs.readFileSync(path.join(dir, "t.osgt"), "utf8");
console.log("Vec3Array count:", (text.match(/Vec3Array/g) || []).length);
for (const m of text.matchAll(/Vec3Array[\s\S]*?vector (\d+)\s*\{([^}]+)\}/g)) {
	const nums = m[2].trim().split(/\s+/).map(Number);
	console.log("array n=", m[1], "first=", nums.slice(0, 6));
}
