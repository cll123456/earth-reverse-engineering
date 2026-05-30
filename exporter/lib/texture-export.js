"use strict";

const decodeTexture = require("./decode-texture");
const bmp = require("bmp-js");
const { PNG } = require("pngjs");

function bmpBufferToPng(bmpBuffer) {
	const bmpData = bmp.decode(bmpBuffer);
	const png = new PNG({ width: bmpData.width, height: bmpData.height });
	for (let i = 0; i < bmpData.width * bmpData.height; i++) {
		const src = i * 4;
		const dst = i * 4;
		png.data[dst] = bmpData.data[src + 3];
		png.data[dst + 1] = bmpData.data[src + 2];
		png.data[dst + 2] = bmpData.data[src + 1];
		png.data[dst + 3] = 255;
	}
	return PNG.sync.write(png);
}

function exportTextureForOsgb(tex) {
	const decoded = decodeTexture(tex);
	if (decoded.extension === "jpg") {
		return decoded;
	}
	if (decoded.extension === "bmp") {
		return {
			extension: "png",
			buffer: bmpBufferToPng(decoded.buffer),
		};
	}
	return decoded;
}

module.exports = {
	exportTextureForOsgb,
	bmpBufferToPng,
};
