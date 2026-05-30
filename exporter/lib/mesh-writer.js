"use strict";

const fs = require("fs-extra");
const path = require("path");
const decodeTexture = require("./decode-texture");
const { exportTextureForOsgb } = require("./texture-export");
const { ecefToWgs84 } = require("./coords");

function applyMatrix(matrix, x, y, z, w) {
	return {
		x: x * matrix[0] + y * matrix[4] + z * matrix[8] + w * matrix[12],
		y: x * matrix[1] + y * matrix[5] + z * matrix[9] + w * matrix[13],
		z: x * matrix[2] + y * matrix[6] + z * matrix[10] + w * matrix[14],
	};
}

function mapExportVertex(coordinateTransform, point) {
	if (coordinateTransform && coordinateTransform.toExportVertex) {
		return coordinateTransform.toExportVertex(point);
	}
	return point;
}

function mapExportNormal(coordinateTransform, normal) {
	if (coordinateTransform && coordinateTransform.toExportNormal) {
		return coordinateTransform.toExportNormal(normal);
	}
	return normal;
}

function createNodeWriter(nodeDir, pathName, coordinateTransform, clipFilter) {
	const objPath = path.join(nodeDir, "node.obj");
	const mtlPath = path.join(nodeDir, "node.mtl");
	const ctx = { c_v: 0, c_n: 0, c_u: 0 };
	let initialized = false;

	function ensureInitialized() {
		if (initialized) return;
		fs.ensureDirSync(nodeDir);
		fs.writeFileSync(objPath, "mtllib node.mtl\n");
		fs.writeFileSync(mtlPath, "");
		initialized = true;
	}

	return {
		nodeDir,
		pathName,
		removeIfEmpty() {
			if (!initialized) {
				if (fs.existsSync(nodeDir)) fs.removeSync(nodeDir);
				return true;
			}
			return false;
		},
		writeNode(node, nodeName, exclude) {
			let wroteAny = false;
			for (const [meshIndex, mesh] of Object.entries(node.meshes)) {
				const meshName = `${nodeName}_${meshIndex}`;
				const texName = `tex_${meshIndex}`;
				const objChunk = writeMeshOBJ(ctx, meshName, texName, node, mesh, exclude, coordinateTransform, clipFilter);
				if (!objChunk) continue;

				ensureInitialized();
				fs.appendFileSync(objPath, objChunk);
				const { buffer, extension } = exportTextureForOsgb(mesh.texture);
				fs.appendFileSync(mtlPath, [
					`newmtl ${texName}`,
					"Ka 1.000 1.000 1.000",
					"Kd 1.000 1.000 1.000",
					"Ks 0.000 0.000 0.000",
					"d 1.0",
					"illum 2",
					`map_Kd ${texName}.${extension}`,
					"",
				].join("\n"));
				fs.writeFileSync(path.join(nodeDir, `${texName}.${extension}`), buffer);
				wroteAny = true;
			}
			return wroteAny;
		},
	};
}

function createTileWriter(tileDir, tileName, coordinateTransform, clipFilter) {
	const objPath = path.join(tileDir, `${tileName}.obj`);
	const mtlPath = path.join(tileDir, `${tileName}.mtl`);
	const ctx = { c_v: 0, c_n: 0, c_u: 0 };
	let initialized = false;

	function ensureInitialized() {
		if (initialized) return;
		fs.ensureDirSync(tileDir);
		fs.writeFileSync(objPath, `mtllib ${tileName}.mtl\n`);
		fs.writeFileSync(mtlPath, "");
		initialized = true;
	}

	return {
		tileDir,
		tileName,
		removeIfEmpty() {
			if (!initialized) {
				if (fs.existsSync(tileDir)) fs.removeSync(tileDir);
				return true;
			}
			return false;
		},
		writeNode(node, nodeName, exclude) {
			let wroteAny = false;
			for (const [meshIndex, mesh] of Object.entries(node.meshes)) {
				const meshName = `${nodeName}_${meshIndex}`;
				const texName = `tex_${nodeName}_${meshIndex}`;
				const objChunk = writeMeshOBJ(ctx, meshName, texName, node, mesh, exclude, coordinateTransform, clipFilter);
				if (!objChunk) continue;

				ensureInitialized();
				fs.appendFileSync(objPath, objChunk);
				const { buffer, extension } = exportTextureForOsgb(mesh.texture);
				fs.appendFileSync(mtlPath, [
					`newmtl ${texName}`,
					"Ka 1.000 1.000 1.000",
					"Kd 1.000 1.000 1.000",
					"Ks 0.000 0.000 0.000",
					"d 1.0",
					"illum 2",
					`map_Kd ${texName}.${extension}`,
					"",
				].join("\n"));
				fs.writeFileSync(path.join(tileDir, `${texName}.${extension}`), buffer);
				wroteAny = true;
			}
			return wroteAny;
		},
	};
}

function writeMeshOBJ(ctx, meshName, texName, payload, mesh, exclude, coordinateTransform, clipFilter) {
	function shouldExclude(w) {
		return Array.isArray(exclude) && exclude.indexOf(w) >= 0;
	}

	const indices = mesh.indices;
	const vertices = mesh.vertices;
	const normals = mesh.normals;
	const matrix = payload.matrixGlobeFromMesh;

	const transformed = [];
	const wgsCoords = [];

	for (let i = 0; i < vertices.length; i += 8) {
		const local = applyMatrix(matrix, vertices[i], vertices[i + 1], vertices[i + 2], 1);
		const wgs = coordinateTransform && coordinateTransform.globeToWgs84
			? coordinateTransform.globeToWgs84(local.x, local.y, local.z)
			: ecefToWgs84(local.x, local.y, local.z);
		wgsCoords.push(wgs);
		if (coordinateTransform) {
			const localPoint = coordinateTransform.fromGlobe
				? coordinateTransform.fromGlobe(local.x, local.y, local.z)
				: coordinateTransform.fromEcef(local.x, local.y, local.z);
			transformed.push(mapExportVertex(coordinateTransform, localPoint));
		} else {
			transformed.push({ x: local.x, y: local.y, z: local.z });
		}
	}

	const triangleGroups = {};
	for (let i = 0; i < indices.length - 2; i += 1) {
		const a = indices[i];
		const b = indices[i + 1];
		const c = indices[i + 2];
		if (a === b || a === c || b === c) continue;
		if (!(vertices[a * 8 + 3] === vertices[b * 8 + 3] && vertices[b * 8 + 3] === vertices[c * 8 + 3])) {
			throw new Error("vertex w mismatch");
		}
		const w = vertices[a * 8 + 3];
		if (shouldExclude(w)) continue;
		if (clipFilter && clipFilter.enabled && !clipFilter.keepTriangle(wgsCoords[a], wgsCoords[b], wgsCoords[c])) {
			continue;
		}
		triangleGroups[w] = (triangleGroups[w] || []).concat([(i & 1) ? [a, c, b] : [a, b, c]]);
	}

	const triangleCount = Object.values(triangleGroups).reduce((sum, group) => sum + group.length, 0);
	if (triangleCount === 0) return null;

	let str = "";
	const log = (line) => { str += `${line}\n`; };
	const _c_v = ctx.c_v;
	const _c_n = ctx.c_n;
	const _c_u = ctx.c_u;
	let c_v = _c_v;
	let c_n = _c_n;
	let c_u = _c_u;

	log(`usemtl ${texName}`);
	log(`o planet_${meshName}`);
	log("# vertices");
	for (const vertex of transformed) {
		log(`v ${vertex.x} ${vertex.y} ${vertex.z}`);
		c_v++;
	}

	if (mesh.uvOffsetAndScale) {
		log("# UV");
		for (let i = 0; i < vertices.length; i += 8) {
			const u1 = vertices[i + 4];
			const u2 = vertices[i + 5];
			const v1 = vertices[i + 6];
			const v2 = vertices[i + 7];
			const u = u2 * 256 + u1;
			const v = v2 * 256 + v1;
			const ut = (u + mesh.uvOffsetAndScale[0]) * mesh.uvOffsetAndScale[2];
			const vt = (v + mesh.uvOffsetAndScale[1]) * mesh.uvOffsetAndScale[3];
			if (mesh.texture.textureFormat === 6) {
				log(`vt ${ut} ${1 - vt}`);
			} else {
				log(`vt ${ut} ${vt}`);
			}
			c_u++;
		}
	}

	log("# Normals");
	for (let i = 0; i < normals.length; i += 4) {
		const normal = applyMatrix(matrix, normals[i] - 127, normals[i + 1] - 127, normals[i + 2] - 127, 0);
		if (coordinateTransform && coordinateTransform.transformNormal) {
			const enuNormal = coordinateTransform.transformNormal(normal.x, normal.y, normal.z);
			const exportNormal = mapExportNormal(coordinateTransform, enuNormal);
			log(`vn ${exportNormal.x} ${exportNormal.y} ${exportNormal.z}`);
		} else {
			log(`vn ${normal.x} ${normal.y} ${normal.z}`);
		}
		c_n++;
	}

	log("# faces");
	for (const triangles of Object.values(triangleGroups)) {
		for (const v of triangles) {
			const a = v[0] + 1;
			const b = v[1] + 1;
			const c = v[2] + 1;
			if (mesh.uvOffsetAndScale) {
				log(`f ${a + _c_v}/${a + _c_u}/${a + _c_n} ${b + _c_v}/${b + _c_u}/${b + _c_n} ${c + _c_v}/${c + _c_u}/${c + _c_n}`);
			} else {
				log(`f ${a + _c_v} ${b + _c_v} ${c + _c_v}`);
			}
		}
	}

	ctx.c_v = c_v;
	ctx.c_u = c_u;
	ctx.c_n = c_n;
	return str;
}

function initLegacyObjWriter(objDir) {
	fs.writeFileSync(path.join(objDir, "model.obj"), "mtllib model.mtl\n");
	const ctx = { objDir, c_v: 0, c_n: 0, c_u: 0 };

	return {
		writeNode(node, nodeName, exclude) {
			for (const [meshIndex, mesh] of Object.entries(node.meshes)) {
				const meshName = `${nodeName}_${meshIndex}`;
				const texName = `tex_${nodeName}_${meshIndex}`;
				const objChunk = writeMeshOBJ(ctx, meshName, texName, node, mesh, exclude, null, null);
				if (!objChunk) continue;
				fs.appendFileSync(path.join(objDir, "model.obj"), objChunk);
				const { buffer, extension } = decodeTexture(mesh.texture);
				fs.appendFileSync(path.join(objDir, "model.mtl"), [
					`newmtl ${texName}`,
					"Kd 1.000 1.000 1.000",
					"d 1.0",
					"illum 0",
					`map_Kd ${texName}.${extension}`,
					"",
				].join("\n"));
				fs.writeFileSync(path.join(objDir, `${texName}.${extension}`), buffer);
			}
		},
	};
}

module.exports = {
	createNodeWriter,
	createTileWriter,
	initLegacyObjWriter,
	writeMeshOBJ,
};
