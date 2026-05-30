"use strict";

function getExcludeOctants(bulk, parentIndex, { hasNodeAtIndex }) {
	const exclude = [];
	for (let o = 0; o < 8; o++) {
		const childIndex = bulk.childIndices[8 * (parentIndex + 1) + o];
		if (childIndex < 0) continue;
		// Match legacy search(): exclude only when a node exists at the direct child path.
		if (hasNodeAtIndex(bulk, childIndex)) {
			exclude.push(o);
		}
	}
	return exclude;
}

module.exports = {
	getExcludeOctants,
};
