"use strict";

const fs = require("fs-extra");
const path = require("path");
const { convertAllTiles, findOsgConv } = require("./lib/osgb-convert");
const { loadIndex, indexPath } = require("./lib/osgb-stream-writer");
const { finalizePagedLodRegion } = require("./lib/osgb-paged-lod");
const { ensureIndexChildMap } = require("./lib/osgb-index");

async function main() {
	const outputDir = path.resolve(process.argv[2] || "./downloaded_files/regions");
	const manifestPath = path.join(outputDir, "region-manifest.json");
	const indexFile = indexPath(outputDir);

	if (await fs.pathExists(indexFile)) {
		if (!findOsgConv()) {
			console.error("osgconv not found");
			process.exitCode = 2;
			return;
		}
		const manifest = await fs.pathExists(manifestPath)
			? await fs.readJson(manifestPath)
			: {};
		const index = ensureIndexChildMap(await loadIndex(outputDir));
		console.log(
			`Building PagedLOD from ${Object.keys(index.nodes).length} indexed node(s)...`,
		);
		const result = await finalizePagedLodRegion(outputDir, {
			index,
			maxLevel: manifest.maxLevel || 22,
			incremental: true,
			saveIndex: true,
		});
		console.log(JSON.stringify(result, null, 2));
		if (result.errors.length > 0) process.exitCode = 1;
		return;
	}

	const result = convertAllTiles(outputDir);
	console.log(JSON.stringify(result, null, 2));
	if (!result.osgConvAvailable) {
		process.exitCode = 2;
	} else if (result.failed > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
