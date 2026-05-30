"use strict";

const fs = require("fs-extra");
const path = require("path");

function writeMetadataXml(outputDir, { epsgCode, srsOrigin }) {
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<ModelMetadata version="1">
	<!--Spatial Reference System-->
	<SRS>${epsgCode}</SRS>
	<!--Origin in Spatial Reference System-->
	<SRSOrigin>${srsOrigin.join(",")}</SRSOrigin>
	<Texture>
		<ColorSource>Visible</ColorSource>
	</Texture>
</ModelMetadata>
`;
	fs.writeFileSync(path.join(outputDir, "metadata.xml"), xml);
}

module.exports = {
	writeMetadataXml,
};
