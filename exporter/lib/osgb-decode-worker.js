"use strict";

// Worker thread for the OSGB export pipeline. The main thread fetches the raw
// (encoded) NodeData bytes and hands them here; this worker does the CPU-heavy part
// off the main thread: protobuf/mesh decode, texture decode, and writing node.obj +
// textures into a fresh temp dir. It returns just the bounds + temp dir path, so the
// big decoded mesh/texture data never crosses the thread boundary. The main thread
// then spawns osgconv on the temp dir (osgconv stays on the main side).

const { parentPort } = require("worker_threads");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const decodeResource = require("./decode-resource");
const { createCoordinateTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createNodeWriter } = require("./mesh-writer");
const { readObjBounds } = require("./osgb-paged-lod");

function buildTransform(transformConfig) {
	if (!transformConfig) return null;
	return createCoordinateTransform(
		transformConfig.epsgInfo,
		transformConfig.bbox,
		transformConfig.globeRadius,
	);
}

// Guard: this module is only meaningful as a worker entry point. Requiring it on the
// main thread (e.g. a smoke test) would otherwise crash on the null parentPort.
if (!parentPort) {
	module.exports = {};
} else parentPort.on("message", (job) => {
	// Two modes:
	//  - convert mode (default): write node.obj to a fresh temp dir, return tempDir for
	//    the main thread to osgconv. exclude masks child octants.
	//  - staging mode (job.outDir set): write the UNMASKED node.obj into the given
	//    persistent dir (for the LOD-pyramid merge); no temp dir, exclude usually [].
	const { pathName, command, payload, transformConfig, clipPolygons, clipEnabled } = job;
	const exclude = job.exclude || [];
	const staging = !!job.outDir;
	let workDir = null;
	(async () => {
		try {
			const decoded = await decodeResource(command, Buffer.from(payload));
			const node = decoded.payload;
			const coordinateTransform = buildTransform(transformConfig);
			const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);

			workDir = staging ? job.outDir : await fs.mkdtemp(path.join(os.tmpdir(), "ere-osgb-"));
			if (staging) await fs.ensureDir(workDir);
			const writer = createNodeWriter(workDir, pathName, coordinateTransform, clipFilter);
			const wroteAny = writer.writeNode(node, pathName, exclude);
			if (!wroteAny) {
				await fs.remove(workDir);
				parentPort.postMessage({ ok: true, pathName, wroteAny: false });
				return;
			}

			const bounds = readObjBounds(path.join(workDir, "node.obj"));
			if (!bounds) {
				await fs.remove(workDir);
				parentPort.postMessage({ ok: true, pathName, wroteAny: false });
				return;
			}

			// Densified-pyramid (model 3) staging: also write the MASKED mesh (child
			// octants removed) into _masked/, used as the "near" geode that persists
			// alongside the real children so non-subdividing octants never disappear.
			let maskedWrote = false;
			const maskOctants = job.maskOctants || [];
			if (staging && maskOctants.length > 0) {
				const maskedDir = path.join(workDir, "_masked");
				await fs.ensureDir(maskedDir);
				const maskedWriter = createNodeWriter(maskedDir, pathName, coordinateTransform, clipFilter);
				maskedWrote = maskedWriter.writeNode(node, pathName, maskOctants);
				if (!maskedWrote) await fs.remove(maskedDir);
			}

			parentPort.postMessage({ ok: true, pathName, wroteAny: true, tempDir: workDir, bounds, maskedWrote });
		} catch (error) {
			if (workDir && !staging) {
				try { await fs.remove(workDir); } catch { /* ignore */ }
			}
			parentPort.postMessage({ ok: false, pathName, error: error.message || String(error) });
		}
	})();
});
