"use strict";

const fs = require("fs-extra");
const path = require("path");
const { createCoordinateTransform } = require("./coords");
const { createClipFilter } = require("./geojson-clip");
const { createTileWriter } = require("./mesh-writer");

function writeTileNode({
	outputDir,
	pathName,
	node,
	exclude,
	transformConfig,
	clipPolygons,
	clipEnabled,
}) {
	const tileName = `Tile_${pathName}`;
	const tileDir = path.join(outputDir, "Data", tileName);
	const coordinateTransform = transformConfig
		? createCoordinateTransform(transformConfig.epsgInfo, transformConfig.bbox, transformConfig.globeRadius)
		: null;
	const clipFilter = createClipFilter(clipPolygons || [], clipEnabled !== false);
	const writer = createTileWriter(tileDir, tileName, coordinateTransform, clipFilter);
	const wroteAny = writer.writeNode(node, pathName, exclude);
	if (!wroteAny) {
		writer.removeIfEmpty();
	}
	return { wroteAny, tileName, tileDir };
}

module.exports = {
	writeTileNode,
};
