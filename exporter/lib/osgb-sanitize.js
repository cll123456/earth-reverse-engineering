"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const { findOsgConv, OSGCONV_INLINE_TEXTURES } = require("./osgb-convert");
const { readOsgbVertexBounds, validateRegionLocalBounds } = require("./osgb-vertex-bounds");

function convertObjToOsgb({ workDir, inputName, outputPath, osgConvPath = null }) {
	const converter = osgConvPath || findOsgConv();
	if (!converter) {
		throw new Error("osgconv not found");
	}
	const outputName = path.basename(outputPath);
	const result = spawnSync(converter, [...OSGCONV_INLINE_TEXTURES, inputName, outputName], {
		cwd: workDir,
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0 || !fs.existsSync(outputPath)) {
		throw new Error(result.stderr || result.stdout || "osgconv failed");
	}
}

function sanitizeConvertedOsgb({
	outputPath,
	workDir = null,
	inputName = null,
	reconvertOnInvalid = true,
}) {
	if (!fs.existsSync(outputPath)) {
		return { ok: false, reason: "missing_output" };
	}

	let bounds;
	try {
		bounds = readOsgbVertexBounds(outputPath);
	} catch (error) {
		if (!reconvertOnInvalid || !workDir || !inputName) {
			throw error;
		}
		convertObjToOsgb({ workDir, inputName, outputPath });
		bounds = readOsgbVertexBounds(outputPath);
	}

	const validation = validateRegionLocalBounds(bounds);
	if (!validation.ok && reconvertOnInvalid && workDir && inputName) {
		convertObjToOsgb({ workDir, inputName, outputPath });
		bounds = readOsgbVertexBounds(outputPath);
		return {
			ok: true,
			bounds,
			reconverted: true,
			validation: validateRegionLocalBounds(bounds),
		};
	}

	return {
		ok: validation.ok,
		bounds,
		reconverted: false,
		validation,
	};
}

module.exports = {
	convertObjToOsgb,
	sanitizeConvertedOsgb,
};
