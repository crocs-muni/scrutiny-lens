import type { GraphResolver, GraphView, NostrEvent } from './types.js';

/**
 * A minimal graph resolver used until the full protocol engine is vendored.
 * It treats `e` tags with marker `reply`/`root`/`mention`/`link` as edges,
 * infers node types from `t` tags, and applies client-side retractions
 * because the relay does not honor NIP-09 deletions.
 */
export const simpleGraphResolver: GraphResolver = (events: NostrEvent[]): GraphView => {
	const retractedIds = new Set<string>();
	for (const event of events) {
		if (event.kind === 5) {
			for (const tag of event.tags) {
				if (tag[0] === 'e' && tag[1]) retractedIds.add(tag[1]);
			}
		}
	}

	const visible = events.filter((e) => !retractedIds.has(e.id));

	const nodes = visible.map((event) => {
		const typeTags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]);
		let type: GraphView['nodes'][number]['type'] = 'metadata';
		if (typeTags.includes('scrutiny-product')) type = 'product';
		else if (typeTags.includes('scrutiny-patch')) type = 'patch';
		else if (typeTags.includes('scrutiny-deletion') || event.kind === 5) type = 'deletion';

		return { id: event.id, type, event };
	});

	const nodeIds = new Set(nodes.map((n) => n.id));
	const edges: GraphView['edges'] = [];

	for (const event of visible) {
		for (const tag of event.tags) {
			if (tag[0] !== 'e' || !tag[1]) continue;
			const targetId = tag[1];
			if (!nodeIds.has(targetId) || targetId === event.id) continue;
			const marker = tag[3] ?? 'ref';
			edges.push({
				id: `${event.id}-${targetId}-${marker}`,
				source: event.id,
				target: targetId,
				label: marker
			});
		}
	}

	return { nodes, edges };
};
