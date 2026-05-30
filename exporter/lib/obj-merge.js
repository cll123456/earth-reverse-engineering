"use strict";

const fs = require("fs-extra");
const path = require("path");

function parseObj(text) {
	const vertices = [];
	const uvs = [];
	const normals = [];
	const faces = [];
	const materials = [];
	let currentMaterial = null;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("v ")) {
			const parts = line.split(/\s+/);
			vertices.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
		} else if (line.startsWith("vt ")) {
			const parts = line.split(/\s+/);
			uvs.push([parseFloat(parts[1]), parseFloat(parts[2])]);
		} else if (line.startsWith("vn ")) {
			const parts = line.split(/\s+/);
			normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
		} else if (line.startsWith("usemtl ")) {
			currentMaterial = line.slice(7).trim();
			materials.push(currentMaterial);
		} else if (line.startsWith("f ")) {
			const parts = line.split(/\s+/).slice(1);
			const indices = parts.map((token) => {
				const [vi, vti, vni] = token.split("/");
				return {
					v: parseInt(vi, 10),
					vt: vti ? parseInt(vti, 10) : null,
					vn: vni ? parseInt(vni, 10) : null,
				};
			});
			if (indices.length >= 3) {
				faces.push({ material: currentMaterial, indices });
			}
		}
	}

	return { vertices, uvs, normals, faces, materials: [...new Set(materials)] };
}

function remapFaceIndex(index, offset, hasArray) {
	if (!hasArray || !index) return null;
	return index + offset;
}

function mergeParsedObjs(parsedList, textureCopies) {
	const out = {
		vertices: [],
		uvs: [],
		normals: [],
		faces: [],
		materials: new Set(),
	};
	const materialMap = new Map();

	for (const parsed of parsedList) {
		const vOffset = out.vertices.length;
		const vtOffset = out.uvs.length;
		const vnOffset = out.normals.length;
		out.vertices.push(...parsed.vertices);
		out.uvs.push(...parsed.uvs);
		out.normals.push(...parsed.normals);

		for (const material of parsed.materials) {
			if (!materialMap.has(material)) {
				materialMap.set(material, material);
				out.materials.add(material);
			}
		}

		for (const face of parsed.faces) {
			const mappedMaterial = materialMap.get(face.material) || face.material;
			out.materials.add(mappedMaterial);
			out.faces.push({
				material: mappedMaterial,
				indices: face.indices.map((idx) => ({
					v: remapFaceIndex(idx.v, vOffset, true),
					vt: remapFaceIndex(idx.vt, vtOffset, out.uvs.length > 0),
					vn: remapFaceIndex(idx.vn, vnOffset, out.normals.length > 0),
				})),
			});
		}
	}

	return { ...out, materials: [...out.materials] };
}

function buildObjText(merged, tileName) {
	const lines = [`mtllib ${tileName}.mtl`];
	let lastMaterial = null;
	for (const face of merged.faces) {
		if (face.material && face.material !== lastMaterial) {
			lines.push(`usemtl ${face.material}`);
			lastMaterial = face.material;
		}
		const tokens = face.indices.map((idx) => {
			if (idx.vt != null && idx.vn != null) {
				return `${idx.v}/${idx.vt}/${idx.vn}`;
			}
			return `${idx.v}`;
		});
		if (tokens.length >= 3) {
			lines.push(`f ${tokens.join(" ")}`);
		}
	}
	const header = [];
	for (const v of merged.vertices) header.push(`v ${v[0]} ${v[1]} ${v[2]}`);
	for (const vt of merged.uvs) header.push(`vt ${vt[0]} ${vt[1]}`);
	for (const vn of merged.normals) header.push(`vn ${vn[0]} ${vn[1]} ${vn[2]}`);
	return [...lines.slice(0, 1), ...header, ...lines.slice(1)].join("\n") + "\n";
}

function buildMtlText(materials, textureByMaterial) {
	const lines = [];
	for (const material of materials) {
		const texture = textureByMaterial[material];
		lines.push(
			`newmtl ${material}`,
			"Ka 1.000 1.000 1.000",
			"Kd 1.000 1.000 1.000",
			"Ks 0.000 0.000 0.000",
			"d 1.0",
			"illum 2",
			texture ? `map_Kd ${texture}` : "",
			"",
		);
	}
	return lines.join("\n");
}

function readMtlTextures(mtlText, tileDir) {
	const textures = {};
	let current = null;
	for (const line of mtlText.split("\n")) {
		if (line.startsWith("newmtl ")) {
			current = line.slice(7).trim();
		} else if (line.startsWith("map_Kd ") && current) {
			const fileName = path.basename(line.slice(7).trim());
			if (fs.existsSync(path.join(tileDir, fileName))) {
				textures[current] = fileName;
			}
		}
	}
	return textures;
}

async function mergeTileGroup(tileDirs, outputDir, outputTileName) {
	const parsedList = [];
	const flatTextures = {};

	for (const tileDir of tileDirs) {
		const tileName = path.basename(tileDir);
		const objPath = path.join(tileDir, `${tileName}.obj`);
		const mtlPath = path.join(tileDir, `${tileName}.mtl`);
		if (!await fs.pathExists(objPath)) continue;
		const objText = await fs.readFile(objPath, "utf8");
		if (!/\nv /.test(objText)) continue;
		parsedList.push(parseObj(objText));
		if (await fs.pathExists(mtlPath)) {
			const textures = readMtlTextures(await fs.readFile(mtlPath, "utf8"), tileDir);
			for (const [material, fileName] of Object.entries(textures)) {
				flatTextures[material] = {
					source: path.join(tileDir, fileName),
					fileName,
				};
			}
		}
	}

	if (parsedList.length === 0) return { status: "empty" };

	const merged = mergeParsedObjs(parsedList, Object.fromEntries(
		Object.entries(flatTextures).map(([material, info]) => [material, info.fileName]),
	));

	await fs.ensureDir(outputDir);
	const objPath = path.join(outputDir, `${outputTileName}.obj`);
	const mtlPath = path.join(outputDir, `${outputTileName}.mtl`);
	await fs.writeFile(objPath, buildObjText(merged, outputTileName));

	const copiedTextures = {};
	for (const material of merged.materials) {
		const info = flatTextures[material];
		if (!info) continue;
		const targetName = `${outputTileName}_${material}${path.extname(info.fileName)}`;
		await fs.copy(info.source, path.join(outputDir, targetName));
		copiedTextures[material] = targetName;
	}
	await fs.writeFile(mtlPath, buildMtlText(merged.materials, copiedTextures));
	return { status: "merged", sourceCount: parsedList.length, objPath };
}

module.exports = {
	parseObj,
	mergeParsedObjs,
	buildObjText,
	mergeTileGroup,
};
