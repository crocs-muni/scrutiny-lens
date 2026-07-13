import type { GraphResolver, GraphView, NostrEvent } from './types.js';

const hasTag = (event: NostrEvent, tag: string): boolean =>
	event.tags.some((t) => t[0] === 't' && t[1] === tag);

/**
 * A minimal graph resolver used until the full protocol engine is vendored.
 * Exactly three entities, per the SCRUTINY protocol spec and the authoritative
 * design mockup (`session-explorer-design`): Product, Metadata, and Bindings
 * as edges.
 *
 * - **Bindings are edges, never nodes** (§1 abstract — "signed edges
 *   (Bindings)"; §4.3 — "A Binding is an immutable directed edge connecting a
 *   Product to a Metadata"; components.md #02 — "Bindings are edges, not
 *   standalone node cards"). A Binding's two `e` tags (marker `root` =
 *   Product, `link` = Metadata) collapse into one edge; direction is
 *   link -> root (Metadata -> Product), per both the spec's "e link -> e
 *   root" wording and the mockup's "arrow points Metadata -> Product".
 * - **Patch events are not graph entities.** They belong in a node's
 *   detail-drawer history timeline, not the canvas (components.md #12).
 * - **Deletion (kind 5) events are not graph entities either.** They only
 *   mark their *target* Product/Metadata node as retracted — the mockup
 *   shows a retracted Product node (hatched + dashed), never a separate
 *   "Deletion" node. Retraction is applied client-side since the relay does
 *   not honor NIP-09 deletions.
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

	const bindingEvents = events.filter((e) => hasTag(e, 'scrutiny-binding'));
	const entityEvents = events.filter(
		(e) => e.kind !== 5 && !hasTag(e, 'scrutiny-binding') && !hasTag(e, 'scrutiny-patch'),
	);

	const nodes = entityEvents.map((event) => ({
		id: event.id,
		type: (hasTag(event, 'scrutiny-product') ? 'product' : 'metadata') as GraphView['nodes'][number]['type'],
		retracted: retractedIds.has(event.id),
		event,
	}));

	const nodeIds = new Set(nodes.map((n) => n.id));
	const edges: GraphView['edges'] = [];

	for (const binding of bindingEvents) {
		const rootId = binding.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1];
		const linkId = binding.tags.find((t) => t[0] === 'e' && t[3] === 'link')?.[1];
		if (!rootId || !linkId || !nodeIds.has(rootId) || !nodeIds.has(linkId)) continue;
		edges.push({ id: binding.id, source: linkId, target: rootId, label: 'binding' });
	}

	return { nodes, edges };
};

/**
 * Filters a fully-resolved graph down to what the user has actually chosen to
 * see: the root node, plus anything reachable by crossing an edge touching a
 * node in `expandedNodeIds`. The root is always implicitly expanded (its own
 * bindings/metadata are the session's base view); every other node starts
 * collapsed until the user clicks its expand affordance.
 *
 * This is deliberately a pure filter over the already-resolved graph, not a
 * new fetch -- expand/collapse only ever changes which subset of already-known
 * nodes is rendered. A node reachable via two different expanded parents
 * stays visible if only one of those parents is later collapsed.
 */
export function visibleSubgraph(
	graph: GraphView,
	rootId: string,
	expandedNodeIds: Iterable<string>,
): GraphView {
	const expanded = new Set(expandedNodeIds);
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	if (!nodeIds.has(rootId)) return { nodes: [], edges: [] };

	const visible = new Set<string>([rootId]);
	const queue = [rootId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current !== rootId && !expanded.has(current)) continue;

		for (const edge of graph.edges) {
			const other = edge.source === current ? edge.target : edge.target === current ? edge.source : null;
			if (other && !visible.has(other)) {
				visible.add(other);
				queue.push(other);
			}
		}
	}

	return {
		nodes: graph.nodes.filter((n) => visible.has(n.id)),
		edges: graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
	};
}
