"use strict";

const fs = require("fs-extra");
const path = require("path");
const { createDumpCore } = require("./lib/dump-core");

const PLANET = "earth";
const URL_PREFIX = `https://kh.google.com/rt/${PLANET}/`;
const DL_DIR = "./downloaded_files";
const [DUMP_OBJ_DIR, DUMP_JSON_DIR, DUMP_RAW_DIR] = ["obj", "json", "raw"].map((x) => path.join(DL_DIR, x));
const { OCTANTS, MAX_LEVEL, DUMP_JSON, DUMP_RAW, PARALLEL_SEARCH } = require("./lib/parse-command-line")(__filename);
const DUMP_OBJ = !(DUMP_JSON || DUMP_RAW);

const utils = require("./lib/utils")({
	URL_PREFIX,
	DUMP_JSON_DIR,
	DUMP_RAW_DIR,
	DUMP_JSON,
	DUMP_RAW,
});

const dumpCore = createDumpCore(utils);

async function run() {
	if (DUMP_OBJ) {
		const octName = OCTANTS.length > 3 ? `${OCTANTS.slice(0, 3).join("+")}+etc` : OCTANTS.join("+");
		const planetoid = await utils.getPlanetoid();
		const rootEpoch = planetoid.bulkMetadataEpoch[0];
		const objDir = path.join(DUMP_OBJ_DIR, `${octName}-${MAX_LEVEL}-${rootEpoch}`);
		await dumpCore.dumpOctants({
			octants: OCTANTS,
			maxLevel: MAX_LEVEL,
			parallelSearch: PARALLEL_SEARCH,
			outputMode: "legacy",
			outputDir: objDir,
		});
		return;
	}

	await dumpCore.dumpOctants({
		octants: OCTANTS,
		maxLevel: MAX_LEVEL,
		parallelSearch: PARALLEL_SEARCH,
		outputMode: "download-only",
		outputDir: DUMP_JSON ? DUMP_JSON_DIR : DUMP_RAW_DIR,
	});
}

(async function program() {
	await run();
})().then(() => {
	process.exit(0);
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
