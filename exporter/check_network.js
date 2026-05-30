"use strict";

const getUrl = require("./lib/get-url");

function parseArgs(argv) {
	const options = { proxy: null, timeoutMs: 120000 };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--proxy") options.proxy = argv[++i];
		if (argv[i] === "--timeout-ms") options.timeoutMs = parseInt(argv[++i], 10);
	}
	return options;
}

async function testUrl(label, url, options) {
	const started = Date.now();
	try {
		const payload = await getUrl(url, false);
		console.log(`OK   ${label} (${payload.length} bytes, ${Date.now() - started}ms)`);
		return true;
	} catch (error) {
		console.log(`FAIL ${label} (${Date.now() - started}ms): ${error.code || error.name || error.message}`);
		return false;
	}
}

async function run() {
	const options = parseArgs(process.argv.slice(2));
	getUrl.configureGetUrl({
		proxy: options.proxy,
		timeoutMs: options.timeoutMs,
		rateLimitMs: 0,
	});

	console.log("Proxy:", getUrl.getConfiguredProxy() || "(none)");
	console.log("Timeout:", options.timeoutMs, "ms");
	console.log("");

	const base = "https://kh.google.com/rt/earth/";
	const tests = [
		["PlanetoidMetadata", `${base}PlanetoidMetadata`],
		["BulkMetadata root", `${base}BulkMetadata/pb=!1m2!1s!2u0`],
	];

	let passed = 0;
	for (const [label, url] of tests) {
		if (await testUrl(label, url, options)) passed++;
	}

	console.log("");
	if (passed === tests.length) {
		console.log("Network check passed.");
		return;
	}

	console.log("Network check failed.");
	console.log("Try another proxy mode/port, for example:");
	console.log("  node check_network.js --proxy http://127.0.0.1:7890");
	console.log("  node check_network.js --proxy socks5://127.0.0.1:7891");
	process.exitCode = 1;
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
