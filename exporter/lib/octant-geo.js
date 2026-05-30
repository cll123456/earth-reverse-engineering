"use strict";

const ROOT_OCTANTS = [
	["02", { n: 0, s: -90, w: -180, e: -90 }],
	["03", { n: 0, s: -90, w: -90, e: 0 }],
	["12", { n: 0, s: -90, w: 0, e: 90 }],
	["13", { n: 0, s: -90, w: 90, e: 180 }],
	["20", { n: 90, s: 0, w: -180, e: -90 }],
	["21", { n: 90, s: 0, w: -90, e: 0 }],
	["30", { n: 90, s: 0, w: 0, e: 90 }],
	["31", { n: 90, s: 0, w: 90, e: 180 }],
];

function normalizeBbox(bbox) {
	return {
		west: bbox.west ?? bbox.w ?? bbox.minLon,
		south: bbox.south ?? bbox.s ?? bbox.minLat,
		east: bbox.east ?? bbox.e ?? bbox.maxLon,
		north: bbox.north ?? bbox.n ?? bbox.maxLat,
	};
}

function boxesIntersect(box, bbox) {
	const b = normalizeBbox(bbox);
	return !(box.e <= b.west || box.w >= b.east || box.n <= b.south || box.s >= b.north);
}

function subdivide(box, key) {
	const midLat = (box.n + box.s) / 2;
	const midLon = (box.w + box.e) / 2;
	let n = box.n;
	let s = box.s;
	let w = box.w;
	let e = box.e;

	if (key & 2) {
		n = midLat;
	} else {
		s = midLat;
	}

	if (n !== 90 && s !== -90) {
		if (key & 1) {
			w = midLon;
		} else {
			e = midLon;
		}
	}

	return { n, s, w, e };
}

function getFirstOctant(lat, lon) {
	if (lat < 0) {
		if (lon < -90) return ["02", { n: 0, s: -90, w: -180, e: -90 }];
		if (lon < 0) return ["03", { n: 0, s: -90, w: -90, e: 0 }];
		if (lon < 90) return ["12", { n: 0, s: -90, w: 0, e: 90 }];
		return ["13", { n: 0, s: -90, w: 90, e: 180 }];
	}
	if (lon < -90) return ["20", { n: 90, s: 0, w: -180, e: -90 }];
	if (lon < 0) return ["21", { n: 90, s: 0, w: -90, e: 0 }];
	if (lon < 90) return ["30", { n: 90, s: 0, w: 0, e: 90 }];
	return ["31", { n: 90, s: 0, w: 90, e: 180 }];
}

function getNextOctant(box, lat, lon) {
	let { n, s, w, e } = box;
	const midLat = (n + s) / 2;
	const midLon = (w + e) / 2;
	let key = 0;

	if (lat < midLat) {
		n = midLat;
	} else {
		s = midLat;
		key += 2;
	}

	if (n === 90 || s === -90) {
		// pole: no longitude split
	} else if (lon < midLon) {
		e = midLon;
	} else {
		w = midLon;
		key += 1;
	}

	return [key, { n, s, w, e }];
}

function applyPathKey(box, key) {
	const midLat = (box.n + box.s) / 2;
	const midLon = (box.w + box.e) / 2;
	let { n, s, w, e } = box;

	if (key & 2) {
		s = midLat;
	} else {
		n = midLat;
	}

	if (n === 90 || s === -90) {
		// pole: no longitude split
	} else if (key & 1) {
		w = midLon;
	} else {
		e = midLon;
	}

	return { n, s, w, e };
}

function pathToBox(path) {
	if (!path || path.length < 2) {
		throw new Error(`Invalid octant path: ${path}`);
	}
	const entry = ROOT_OCTANTS.find(([prefix]) => path.startsWith(prefix));
	if (!entry) {
		throw new Error(`Unknown octant path root: ${path}`);
	}
	let box = { ...entry[1] };
	for (let i = entry[0].length; i < path.length; i++) {
		box = applyPathKey(box, parseInt(path[i], 10));
	}
	return box;
}

function latLonToOctantPath(lat, lon, maxLevel) {
	let [nodePath, box] = getFirstOctant(lat, lon);
	while (nodePath.length < maxLevel) {
		const [nextKey, nextBox] = getNextOctant(box, lat, lon);
		nodePath += String(nextKey);
		box = nextBox;
	}
	return nodePath;
}

module.exports = {
	ROOT_OCTANTS,
	normalizeBbox,
	boxesIntersect,
	subdivide,
	applyPathKey,
	getFirstOctant,
	getNextOctant,
	pathToBox,
	latLonToOctantPath,
};
