"use strict";

const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");
const { findOsgConv } = require("./osgb-convert");

function parseVertexArraysFromOsgt(text) {
	const arrays = [];
	for (const match of text.matchAll(/VertexArray TRUE \{[\s\S]*?vector (\d+)\s*\{([^}]+)\}/g)) {
		const count = parseInt(match[1], 10);
		const nums = match[2].trim().split(/\s+/).map(Number);
		const verts = [];
		for (let i = 0; i + 2 < nums.length; i += 3) {
			verts.push([nums[i], nums[i + 1], nums[i + 2]]);
		}
		arrays.push({ count, verts });
	}
	return arrays;
}

function boundsFromVertices(verts) {
	if (verts.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	for (const [x, y, z] of verts) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		minZ = Math.min(minZ, z);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
		maxZ = Math.max(maxZ, z);
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const cz = (minZ + maxZ) / 2;
	const radius = Math.sqrt(
		(maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2,
	) / 2;
	return {
		minX,
		minY,
		minZ,
		maxX,
		maxY,
		maxZ,
		cx,
		cy,
		cz,
		radius: Math.max(radius, 1),
		vertexCount: verts.length,
	};
}

function readOsgbVertexBounds(osgbPath, osgConvPath = null) {
	const converter = osgConvPath || findOsgConv();
	if (!converter) {
		throw new Error("osgconv not found");
	}
	const dir = path.dirname(osgbPath);
	const tempOsgt = path.join(dir, `_vb_${path.basename(osgbPath, ".osgb")}.osgt`);
	const result = spawnSync(converter, [path.basename(osgbPath), path.basename(tempOsgt)], {
		cwd: dir,
		stdio: "pipe",
		encoding: "utf8",
	});
	if (result.status !== 0 || !fs.existsSync(tempOsgt)) {
		throw new Error(result.stderr || result.stdout || `osgconv failed for ${osgbPath}`);
	}
	const text = fs.readFileSync(tempOsgt, "utf8");
	fs.removeSync(tempOsgt);

	const arrays = parseVertexArraysFromOsgt(text);
	if (arrays.length === 0) return null;

	let merged = null;
	for (const array of arrays) {
		const bounds = boundsFromVertices(array.verts);
		if (!bounds) continue;
		if (!merged) {
			merged = bounds;
			continue;
		}
		merged = {
			minX: Math.min(merged.minX, bounds.minX),
			minY: Math.min(merged.minY, bounds.minY),
			minZ: Math.min(merged.minZ, bounds.minZ),
			maxX: Math.max(merged.maxX, bounds.maxX),
			maxY: Math.max(merged.maxY, bounds.maxY),
			maxZ: Math.max(merged.maxZ, bounds.maxZ),
			vertexCount: merged.vertexCount + bounds.vertexCount,
		};
	}
	if (!merged) return null;
	const cx = (merged.minX + merged.maxX) / 2;
	const cy = (merged.minY + merged.maxY) / 2;
	const cz = (merged.minZ + merged.maxZ) / 2;
	const radius = Math.sqrt(
		(merged.maxX - merged.minX) ** 2 + (merged.maxY - merged.minY) ** 2 + (merged.maxZ - merged.minZ) ** 2,
	) / 2;
	return {
		cx,
		cy,
		cz,
		radius: Math.max(radius, 1),
		minX: merged.minX,
		minY: merged.minY,
		minZ: merged.minZ,
		maxX: merged.maxX,
		maxY: merged.maxY,
		maxZ: merged.maxZ,
		vertexCount: merged.vertexCount,
		geometryCount: arrays.length,
	};
}

function validateTileLocalBounds(bounds, gridCellSize, margin = 120) {
	if (!bounds) {
		return { ok: false, reason: "no_vertex_data" };
	}
	const limit = gridCellSize + margin;
	if (bounds.minX < -margin || bounds.maxX > limit
		|| bounds.minY < -margin || bounds.maxY > limit) {
		return {
			ok: false,
			reason: "outside_tile_local_range",
			min: [bounds.minX, bounds.minY, bounds.minZ],
			max: [bounds.maxX, bounds.maxY, bounds.maxZ],
		};
	}
	return { ok: true };
}

function validateRegionLocalBounds(bounds, maxAbs = 5000) {
	if (!bounds) {
		return { ok: false, reason: "no_vertex_data" };
	}
	const absMax = Math.max(
		Math.abs(bounds.minX),
		Math.abs(bounds.maxX),
		Math.abs(bounds.minY),
		Math.abs(bounds.maxY),
		Math.abs(bounds.minZ),
		Math.abs(bounds.maxZ),
	);
	if (absMax > maxAbs) {
		return {
			ok: false,
			reason: "absolute_coords_in_vertices",
			absMax,
		};
	}
	if (absMax > 1e5) {
		return { ok: false, reason: "projected_absolute_coords", absMax };
	}
	return { ok: true };
}

module.exports = {
	parseVertexArraysFromOsgt,
	boundsFromVertices,
	readOsgbVertexBounds,
	validateTileLocalBounds,
	validateRegionLocalBounds,
};
