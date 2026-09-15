/**
 * Ego extraction (issue #29b, canvas slice): derive the ego graph around the
 * session's canvas root from the ADMITTED store — the only data the graph
 * canvas may show (ruling 8: admitted-only expansion, no fetch-on-expand).
 *
 * Design rulings baked in (#29 grill, 2026-09-14):
 *
 *  - Ego scope (ruling 2): root hub center-stage, admitted neighbors in ring 1,
 *    shared metadata exposes the other end as a SHADOW hub with a +N badge,
 *    expansion reveals only admitted events. Forest mode is deliberately
 *    unbuilt.
 *  - Manual deterministic radial (ruling 3): root at origin; ring-1 spokes
 *    laid on an 8-slot dyadic grid by ADMISSION ORDER (first appearance in
 *    the events array) — slots are n-independent, so mid-session arrivals
 *    never move a placed node (the ruling's append-only clause; its verb-
 *    grouping convenience was mutually exclusive and lost — recorded in
 *    the PR body). Overflow spokes step onto outer rings.
 *  - Retraction (ruling 10 / N3): retracted nodes vanish from the canvas
 *    unless Show deleted — EXCEPT the root itself: the canvas mirrors an
 *    explicitly opened dossier, and a dossier always renders (ruling 3/#29a).
 *  - Chain word (ruling 9): one amber footer word, verbatim from core
 *    resolve()'s chain status — halted / forked / stopped at limit (§5.4:
 *    an abort is never named "halted"). Clean chains show plain `edited ×N`
 *    (N1⑥, applied canonical patches only). No word without patches.
 *  - resolveGraph drops bindings whose other endpoint isn't admitted
 *    (dossier.ts header) — the canvas never counts those in +N; the dossier
 *    Files section owns the admitted-binding ledger. Shadow badges count
 *    PLACEMENT-hidden neighbors only ("admitted but not on canvas").
 *
 * Everything here is pure: no Svelte, no stores, no AI output. Unit-tested
 * as a trust gate (positions deterministic, badges counted, filters exact).
 */

import {
	isDefaultViewRetracted,
	resolve,
	scrutinyEventType,
	type CoreNostrEvent,
	type NostrEvent,
	type Resolution
} from '$lib/fabric';
import { bindingEndpoints } from '$lib/fabric';
import { deriveFallbackTitle, type ProductCard } from '$lib/pipeline/cards';

/** Radial roles — ring 1 spokes orbit the root; shadows are unexpanded
 * multihop ends (N3). Role drives placement + dimming, kind drives anatomy. */
export type EgoRole = 'root' | 'spoke' | 'shadow';

export type NodeKind = 'product' | 'metadata';

/** Ruling 9's amber footer word, mapped 1:1 from ChainState.status. */
export type ChainWord = 'halted' | 'forked' | 'stopped at limit';

export interface EgoNode {
	id: string;
	kind: NodeKind;
	role: EgoRole;
	event: NostrEvent;
	retracted: boolean;
	/** Cache-first title (products) or rule-5 mono fallback — same voice
	 * split as the dossier (§9 writing rule). */
	title: string;
	interpreted: boolean;
	pubkey: string;
	createdAt: number;
	/** Hub one-liner: products only, interpreted only (BIBLE N1 ④). */
	snippet: string | undefined;
	/** Hub icon-counts: admitted bindings to metadata / with http(s) content —
	 * counted over the FULL admitted set (dossier parity, ADR 0001), not the
	 * placed subset. */
	boundMetadata: number;
	files: number;
	/** Applied canonical patches (resolve()'s chain.applied.length) — the N
	 * in `edited ×N` (N1⑥; 0 → the footer omits the word). */
	editedN: number;
	chainWord: ChainWord | null;
	/** Shadow badge: admitted neighbors hidden by placement — never zero-shown
	 * (BILE: never zero-shown); null on non-shadows. */
	badge: number | null;
	/** xyflow position (px, center-origin). */
	x: number;
	y: number;
}

export interface EgoEdge {
	id: string;
	/** Metadata end (xyflow source — arrows point Metadata → Product). */
	source: string;
	target: string;
	/** The binding event's content — the verb ("documents"). '' = none. */
	label: string;
	/** Handles face each other across the edge (quadrants of the from→to
	 * vector) so curves never pierce cards. */
	sourceHandle: HandleSide;
	targetHandle: HandleSide;
	/** Edge into a shadow hub — N3/G1 dashed "also affects → multihop". */
	shadowed: boolean;
}

export type HandleSide = 'left' | 'right' | 'top' | 'bottom';

export interface EgoView {
	nodes: EgoNode[];
	edges: EgoEdge[];
}

/** ONE fit contract for the flow's mount AND the toolbar's Fit button
 * (Standards P2-1 — diverging paddings/caps let the toolbar defeat the
 * framing). */
export const FIT_OPTIONS = { padding: 0.2, maxZoom: 0.85 } as const;

export interface EgoOptions {
	showDeleted: boolean;
	/** Shadow hubs whose admitted neighbors are revealed (ruling 8). */
	expanded: ReadonlySet<string>;
	/** The interpretations cache's materialized face (product titles/snippets). */
	cards: ProductCard[];
}

/* ------------------------------------------------------------------ *
 * Layout constants — the radial grammar (ruling 3).
 * Ring 1 needs enough arc per spoke that cards don't touch (hub width
 * 250 + air); ring radius grows with n instead of crowding. Sized so a
 * 1-hub + ≤6-spoke ego fits a drawer-open canvas near tier-full zoom:
 * oversized radii push fitView under the N4 dense floors (owner
 * screenshot 2026-09-14).
 * ------------------------------------------------------------------ */
/* Geometric floor, not a taste tone: the hub card is 250px wide, a spoke
 * 230px — every gap must clear card-half + neighbor-half + a 12px gutter,
 * or the first spoke lands ON the hub (owner screenshot 2026-09-14). All
 * steps derive from that one constraint. */
const R_STEP = 250;
const R1_MIN = 252;
/** Fan step between an expanded shadow's own spokes (rad). */
const FAN_STEP = 0.5;
/** Dyadic slot grid (ruling 3's append-only, done honestly): a spoke's
 * slot is its ADMISSION ORDER among ring-1 members, never its rank in a
 * verb sort — a sort recomputes every existing angle when a new neighbor
 * arrives mid-session (Spec review finding 2026-09-14). Slots are
 * n-independent: bit-reversed index × 45° spreads each prefix maximally
 * (0, 180, 90, 270, 45, 135, 225, 315). */
const SLOT_ANGLE = Math.PI / 4;
const SLOTS_PER_QUAD = 8;

function dyadicAngle(k: number): number {
	const rev = ((k & 1) << 2) | (k & 2) | ((k & 4) >> 2);
	return rev * SLOT_ANGLE;
}

/** Slot radius. The four CARDINAL slots (0°/90°/180°/270°) live on the
 * inner ring; the four DIAGONAL slots move one ring out — at 45° on the
 * inner ring the 5th/6th… spoke collides with a cardinal neighbor (chord
 * 194px < 240px required). Overflow slots repeat the grid +1 ring each. */
function radiusFor(slot: number): number {
	const quad = slot % SLOTS_PER_QUAD;
	const ring = (slot - quad) / SLOTS_PER_QUAD;
	return (quad < 4 ? R1_MIN : R1_MIN + 180) + ring * R_STEP;
}

/** The other endpoint of a binding row from one participant's side —
 * the ×6 ternary deduplicated (Standards P2-2). */
function otherEnd(row: BindingRow, id: string): string {
	return row.productId === id ? row.metadataId : row.productId;
}

/** Quadrant of the from→to vector — the side the edge should attach to. */
export function sideToward(dx: number, dy: number): HandleSide {
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
	return dy >= 0 ? 'bottom' : 'top';
}

/** One cast per boundary (fabric seam policy) — matches fabric/index.ts. */
function asCore(event: NostrEvent): CoreNostrEvent {
	return event as unknown as CoreNostrEvent;
}

interface BindingRow {
	id: string;
	/** core's 'root' endpoint = the product (Standards P3-7: the field's
	 * old name collided with the ego anchor param). */
	productId: string;
	/** core's 'link' endpoint = the metadata. */
	metadataId: string;
	label: string;
}

/** The amber footer word, verbatim from the resolution (ruling 9). */
export function chainWordOf(resolution: Resolution): { word: ChainWord | null; editedN: number } {
	switch (resolution.chain.status) {
		case 'halted':
			return { word: 'halted', editedN: resolution.chain.applied.length };
		case 'forked':
			return { word: 'forked', editedN: 0 };
		case 'aborted':
			return { word: 'stopped at limit', editedN: resolution.chain.applied.length };
		case 'resolved':
			return { word: null, editedN: resolution.chain.applied.length };
		case 'absent':
			return { word: null, editedN: 0 };
	}
}

/**
 * Derive the ego view. `events` is the session's admitted set (ADR 0001:
 * store, never the facet-filtered view). Returns empty when the root is
 * absent or not a product/metadata event — the canvas renders its honest
 * empty state, never a placeholder graph.
 */
export function deriveEgo(
	events: NostrEvent[],
	rootId: string,
	opts: EgoOptions
): EgoView {
	const coreEvents = events as unknown as CoreNostrEvent[];
	const rootEvent = events.find((e) => e.id === rootId);
	if (rootEvent === undefined) return { nodes: [], edges: [] };
	const rootKind = scrutinyEventType(asCore(rootEvent));
	if (rootKind !== 'product' && rootKind !== 'metadata') return { nodes: [], edges: [] };

	// Products/metadata only; bindings index BOTH directions (the ego walkers
	// need every binding touching an id, not arrow order).
	const byId = new Map<string, NostrEvent>();
	const kinds = new Map<string, NodeKind>();
	const deletions: CoreNostrEvent[] = [];
	const bindings: BindingRow[] = [];
	const bindingsByEndpoint = new Map<string, BindingRow[]>();
	for (const event of events) {
		if (event.kind === 5) {
			deletions.push(asCore(event));
			continue;
		}
		const type = scrutinyEventType(asCore(event));
		if (type === 'product' || type === 'metadata') {
			byId.set(event.id, event);
			kinds.set(event.id, type);
			continue;
		}
		if (type !== 'binding') continue;
		const ends = bindingEndpoints(asCore(event));
		if (ends == null) continue;
		const row: BindingRow = { id: event.id, productId: ends.rootId, metadataId: ends.linkId, label: event.content };
		bindings.push(row);
		for (const id of [ends.rootId, ends.linkId]) {
			const list = bindingsByEndpoint.get(id) ?? [];
			list.push(row);
			bindingsByEndpoint.set(id, list);
		}
	}

	/** A node renders when alive, or when Show deleted is on, or when it IS
	 * the root (an explicitly opened dossier always renders — ruling 10). */
	const retractedCache = new Map<string, boolean>();
	function retracted(id: string): boolean {
		const hit = retractedCache.get(id);
		if (hit !== undefined) return hit;
		const ev = byId.get(id);
		if (ev === undefined) return false;
		const r = isDefaultViewRetracted(asCore(ev), deletions);
		retractedCache.set(id, r);
		return r;
	}
	const visible = (id: string): boolean =>
		byId.has(id) && (opts.showDeleted || id === rootId || !retracted(id));

	// Neighbor walk over admitted bindings only (ruling 8) — a binding whose
	// counterparty was never admitted contributes NOTHING (no node, no edge,
	// no badge count): the graph never claims evidence the store can't show.
	const ring1 = new Map<string, BindingRow>(); // nodeId → binding that brought it
	for (const b of bindingsByEndpoint.get(rootId) ?? []) {
		const other = otherEnd(b, rootId);
		if (!visible(other)) continue;
		// First binding wins (Spec finding (c)2): a duplicate binding with a
		// different verb must never re-cluster a node or swap its edge.
		if (!ring1.has(other)) ring1.set(other, b);
	}

	// Shadows: ring-2 products behind a ring-1 bridge. Expanded shadows become
	// full nodes and contribute their OWN ring of visible neighbors.
	const expanded = opts.expanded;
	const shadowOf = new Map<string, string[]>(); // shadowId → bridge ids
	const promoted = new Map<string, BindingRow>(); // expanded shadow → its ring-2 style nodes
	const ring3 = new Map<string, { anchor: string; binding: BindingRow }>();
	for (const [bridgeId] of [...ring1].sort(([a], [b]) => a.localeCompare(b))) {
		for (const b of bindingsByEndpoint.get(bridgeId) ?? []) {
			const other = otherEnd(b, bridgeId);
			if (other === rootId || ring1.has(other) || !visible(other)) continue;
			// Bridge bookkeeping is identical expanded or not (Standards
			// P2-2 — was duplicated in both arms).
			const bridges = shadowOf.get(other) ?? [];
			if (!bridges.includes(bridgeId)) bridges.push(bridgeId);
			shadowOf.set(other, bridges);
			if (expanded.has(other)) {
				if (!promoted.has(other)) promoted.set(other, b);
				for (const inner of bindingsByEndpoint.get(other) ?? []) {
					const leaf = otherEnd(inner, other);
					if (leaf === rootId || leaf === other || ring1.has(leaf) || !visible(leaf)) continue;
					if (!ring3.has(leaf)) ring3.set(leaf, { anchor: other, binding: inner });
				}
			}
		}
	}

	/* ---------------- placement (admission-order slots, dyadic spread) ----
	 * Ruling 3 done honestly: a spoke's slot = its ADMISSION ORDER among
	 * ring-1 members (first appearance in the events array). A verb sort
	 * re-clusters on every new arrival — existing nodes jump, the ruling's
	 * append-only clause dies (Spec finding a1, 2026-09-14). The ruling's
	 * verb-grouping convenience loses to its stability clause; the tradeoff
	 * is recorded in the PR. Slots are n-independent (dyadic bit-reversal),
	 * so prefix-consistent store growth NEVER moves a placed node. */
	const admission = new Map(events.map((e, i) => [e.id, i]));
	const placed = new Map<string, { x: number; y: number }>();
	placed.set(rootId, { x: 0, y: 0 });

	const ring1Ids = [...ring1.keys()];
	ring1Ids.sort((a, b) => (admission.get(a) ?? 0) - (admission.get(b) ?? 0));
	const angleOf = new Map<string, number>();
	ring1Ids.forEach((id, slot) => {
		// Slot 0 lands EAST; the dyadic sequence keeps every prefix size
		// maximally spread (0, 180, 90, 270, 45, 135, 225, 315…).
		const angle = dyadicAngle(slot % SLOTS_PER_QUAD);
		angleOf.set(id, angle);
		const r = radiusFor(slot);
		placed.set(id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
	});

	// Shadows + promoted hubs: one radius out along the circular mean of their
	// bridges' angles — the multihop ray reads outward (G1).
	const outerRing = ring1Ids.length === 0 ? R1_MIN : radiusFor(ring1Ids.length - 1);
	// Ring 2 (shadow hubs — products, 250px) and ring 3 (their metadata
	// spokes): each step clears neighbor-half of the wider side pair.
	const r2 = outerRing + R_STEP;
	const r3 = r2 + R_STEP;
	const shadowAngle = new Map<string, number>();
	for (const [shadowId, bridges] of [...shadowOf].sort(([a], [b]) => a.localeCompare(b))) {
		const angles = bridges.map((b) => angleOf.get(b) ?? 0);
		// Circular mean keeps bridges on opposite sides from averaging to 0.
		const mx = angles.reduce((s, a) => s + Math.cos(a), 0) / angles.length;
		const my = angles.reduce((s, a) => s + Math.sin(a), 0) / angles.length;
		const angle = Math.atan2(my, mx);
		shadowAngle.set(shadowId, angle);
		placed.set(shadowId, { x: r2 * Math.cos(angle), y: r2 * Math.sin(angle) });
	}

	// Ring 3: an expanded hub's own spokes, fanned around its anchor ray.
	const byAnchor = new Map<string, string[]>();
	for (const [leaf, { anchor }] of ring3) {
		const list = byAnchor.get(anchor) ?? [];
		list.push(leaf);
		byAnchor.set(anchor, list);
	}
	for (const [anchor, leaves] of byAnchor) {
		const anchorAngle = shadowAngle.get(anchor) ?? 0;
		leaves.sort((a, b) => (admission.get(a) ?? 0) - (admission.get(b) ?? 0));
		leaves.forEach((id, i) => {
			const angle = anchorAngle + (i - (leaves.length - 1) / 2) * FAN_STEP;
			angleOf.set(id, angle);
			placed.set(id, { x: r3 * Math.cos(angle), y: r3 * Math.sin(angle) });
		});
	}

	/* ---------------- node materialization ---------------- */
	const cardsById = new Map(opts.cards.map((c) => [c.id, c]));
	function nodeFor(id: string, role: EgoRole): EgoNode {
		const event = byId.get(id) as NostrEvent;
		const kind = kinds.get(id) as NodeKind;
		const card = cardsById.get(id);
		const interpreted = card !== undefined && card.interpreted;
		const resolution = resolve(id, coreEvents);
		const { word, editedN } = chainWordOf(resolution);
		// Hub counts scan ALL admitted bindings (dossier parity — the node's
		// icon-counts are the Files-section rows, not the placed subset). No
		// counterparty-kind filter: bindings link product↔metadata by
		// protocol, so for a metadata ego root the counted rows are its bound
		// products — the same rows its dossier Files section renders.
		const bound = bindingsByEndpoint.get(id) ?? [];
		const files = bound.filter((b) => {
			const ev = byId.get(otherEnd(b, id));
			return ev !== undefined && /https?:\/\//.test(ev.content);
		});
		// Materialized ids are placed by construction (root/ring-1/shadow/
		// ring-3 sets drive both) — a placement regression must scream, not
		// collapse a node onto the origin (Standards P3-5).
		const pos = placed.get(id);
		if (pos === undefined) throw new Error(`ego: ${id} materialized without placement (layout regression)`);
		// Shadow badge: admitted neighbors placement hides (never zero-shown —
		// a visible-already neighbor is an edge, not a badge).
		const hidden = (bindingsByEndpoint.get(id) ?? []).filter((b) => {
			const other = otherEnd(b, id);
			return visible(other) && other !== rootId && !placed.has(other);
		}).length;
		return {
			id,
			kind,
			role,
			event,
			retracted: retracted(id),
			title: interpreted && card !== undefined ? card.title : deriveFallbackTitle(event),
			interpreted,
			pubkey: event.pubkey,
			createdAt: event.created_at,
			snippet: kind === 'product' && interpreted ? card?.snippet : undefined,
			boundMetadata: bound.length,
			files: files.length,
			editedN,
			chainWord: word,
			badge: hidden > 0 ? hidden : null,
			x: pos.x,
			y: pos.y
		};
	}

	const nodes: EgoNode[] = [nodeFor(rootId, 'root')];
	for (const id of ring1Ids) nodes.push(nodeFor(id, 'spoke'));
	for (const [shadowId] of [...shadowOf].sort(([a], [b]) => a.localeCompare(b))) {
		nodes.push(nodeFor(shadowId, expanded.has(shadowId) ? 'spoke' : 'shadow'));
	}
	for (const [leaf] of ring3) nodes.push(nodeFor(leaf, 'spoke'));

	/* ---------------- edges ---------------- */
	const edges: EgoEdge[] = [];
	function pushEdge(b: BindingRow, shadowed: boolean): void {
		const from = placed.get(b.metadataId);
		const to = placed.get(b.productId);
		// Same invariant as nodeFor: an edge whose endpoints aren't placed is
		// a layout regression, not something to drop quietly.
		if (from === undefined || to === undefined) {
			throw new Error(`ego: edge ${b.id} references unplaced endpoint (layout regression)`);
		}
		const sSide = sideToward(to.x - from.x, to.y - from.y);
		const tSide = sideToward(from.x - to.x, from.y - to.y);
		edges.push({
			id: b.id,
			source: b.metadataId,
			target: b.productId,
			label: b.label,
			sourceHandle: sSide,
			targetHandle: tSide,
			shadowed
		});
	}
	// Ring-1 ↔ root edges.
	for (const [, b] of ring1) pushEdge(b, false);
	// Bridge ↔ shadow/promoted and promoted ↔ ring-3 edges.
	for (const [shadowId, bridges] of shadowOf) {
		for (const bridgeId of bridges) {
			const b = (bindingsByEndpoint.get(bridgeId) ?? []).find(
				(row) => otherEnd(row, bridgeId) === shadowId
			);
			if (b !== undefined) pushEdge(b, !expanded.has(shadowId));
		}
	}
	for (const [, { binding }] of ring3) {
		pushEdge(binding, false);
	}

	// Edge order derives from ring walks, which follow event input order —
	// sort so the view depends on ids alone (determinism, same as nodes).
	edges.sort((a, b) => a.id.localeCompare(b.id));
	return { nodes, edges };
}
