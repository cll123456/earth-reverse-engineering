// Validate the CC-format densified pyramid output: every node's single entry file exists,
// tile roots exist, and no aux _complete/_masked geode files are left behind (they are
// inlined into the entry file at finalize). Filename-level check => proves no dangling
// child references (children are referenced by entry filename).
const path = require("path");
const fs = require("fs-extra");
const { buildLodTree } = require("./lib/osgb-paged-lod");
const { osgbFileName, geodeNames, isInternalNode } = require("./lib/osgb-densify-pyramid");

const regionDir = process.argv[2];
const index = fs.readJsonSync(path.join(regionDir, ".region-osgb-index.json"));
const dataDir = path.join(regionDir, "Data");
const paths = Object.keys(index.nodes || {});
const { childrenOf } = buildLodTree(paths);

let missingEntry = 0, leftoverAux = 0, danglingChildRef = 0, internal = 0, leaf = 0;
const ex = (f) => fs.existsSync(f);
for (const p of paths) {
  const t = index.nodes[p].gridTile;
  const tileDir = path.join(dataDir, t);
  const names = geodeNames(t, p);
  if (!ex(path.join(tileDir, names.entry))) { missingEntry++; if (missingEntry <= 5) console.log("MISSING ENTRY:", p, names.entry); }
  if (isInternalNode(index, p)) {
    internal++;
    // aux geodes must be inlined + removed by finalize — none should remain
    if (ex(path.join(tileDir, names.complete))) { leftoverAux++; if (leftoverAux <= 5) console.log("LEFTOVER _complete:", p); }
    if (ex(path.join(tileDir, names.masked))) { leftoverAux++; if (leftoverAux <= 5) console.log("LEFTOVER _masked:", p); }
    // child entry refs
    const inTile = new Set(paths.filter((q) => index.nodes[q].gridTile === t));
    for (const c of (childrenOf[p] || []).filter((c) => inTile.has(c))) {
      const ct = index.nodes[c].gridTile;
      if (!ex(path.join(dataDir, ct, osgbFileName(ct, c)))) { danglingChildRef++; if (danglingChildRef <= 5) console.log("DANGLING child ref:", p, "->", c); }
    }
  } else leaf++;
}
// tile roots
const tiles = [...new Set(paths.map((p) => index.nodes[p].gridTile))];
let missingRoot = 0;
for (const t of tiles) if (!ex(path.join(dataDir, t, `${t}.osgb`))) { missingRoot++; if (missingRoot <= 5) console.log("MISSING ROOT:", t); }

console.log("\n--- summary ---");
console.log("nodes:", paths.length, "internal:", internal, "leaf:", leaf, "tiles:", tiles.length);
console.log("missingEntry:", missingEntry, "leftoverAux:", leftoverAux, "danglingChildRef:", danglingChildRef, "missingRoot:", missingRoot);
console.log(missingEntry + leftoverAux + danglingChildRef + missingRoot === 0 ? "OK: clean CC layout, no dangling references" : "PROBLEMS FOUND");
