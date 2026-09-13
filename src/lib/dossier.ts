/**
 * Dossier derivation (issue #29a) — the detail drawer's single data source.
 *
 * Everything here is deterministic: the drawer's four sections render this
 * shape verbatim, so the drawer's landing PR can assert "AI writes nothing in
 * the drawer" structurally (spec §2 rule 1). The ONE cache read is the card
 * title/description on a cache hit — the interpretations cache keyed
 * (eventId, model) that the results cards already read (spec §6); a miss
 * never spawns an AI call, it falls back to the exact rule-5 vocabulary the
 * card shows (deriveFallbackTitle, exported from cards.ts so the fallback
 * cannot drift between surfaces).
 *
 * Protocol seam rulings baked in:
 * - core.resolve() is the sole patch source (AGENTS.md hard rule). History
 *   rows map Resolution fields 1:1 — no chain reconstruction of our own,
 *   which is why a forked chain lists exactly what resolve() reports (shared
 *   parent + branches) instead of manufacturing positions it did not give.
 * - Content shows what resolve() computed, bannered when that content is
 *   frozen (halted/forked/aborted): signed truth with a named scope. The
 *   aborted banner says "stopped at limit", NEVER "halted" — §5.4 forbids
 *   surfacing a resource ceiling as a HALT.
 * - History = canonical chain rows + the retraction row + a non-canonical
 *   group (root-author pending patches + foreign overlays with their §7.3
 *   state). The drawer count equals rows rendered (spec §2 rule 2).
 * - Files rows mirror the fabric seam's own edge semantics: verb = binding
 *   content, arrowhead at the root end (Metadata → Product). A counterparty
 *   outside the admitted set renders as a bare mono id — never a fabricated
 *   label.
 */

import {
	DELETION_KIND,
	bindingEndpoints,
	isDefaultViewRetracted,
	resolve,
	scrutinyEventType,
	tagValues,
	type NostrEvent,
	type OverlayState,
	type Resolution
} from '$lib/fabric';
import { deriveFallbackTitle, type ProductCard } from '$lib/pipeline/cards';

export interface DossierTitle {
	text: string;
	/** Cache hit → true (sans, AI prose). Miss → false (mono, rule-5). */
	interpreted: boolean;
}

/** Point-states the History section renders (spec §0 via resolve() fields).
 * `position` is 1-based on the canonical chain, 0 for the root row, and null
 * for every non-canonical row — resolve() reports no chain position for
 * overlays/pending, and inventing one would be hand-rolled chain logic. */
export type ChainPointState =
	| 'root'
	| 'applied'
	| 'halted-here'
	| 'fork-parent'
	| 'fork-branch'
	| 'pending'
	| 'overlay'
	| 'retraction';

export interface HistoryRow {
	id: string;
	author: string;
	createdAt: number;
	position: number | null;
	state: ChainPointState;
	/** §7.3 state word — set iff state === 'overlay'. */
	overlayState?: OverlayState;
	/** The overlay's target id (mono detail in the row). */
	targetId?: string;
	/** False → renders under the "not in the canonical chain" group. */
	canonical: boolean;
}

export interface FileRow {
	bindingId: string;
	/** The binding event's own content — the edge verb ("documents"). '' =
	 * no verb carried; the row omits it (BIBLE: never zero-shown). */
	verb: string;
	counterpartyId: string;
	/** Observed counterparty's rule-5/cache title; null → bare mono id. */
	counterpartyLabel: string | null;
	/** Metadata → Product per the fabric seam: the root endpoint is the
	 * arrowhead end. 'subject' — the dossier's event is the product. */
	destination: 'subject' | 'counterparty';
}

export interface DossierContent {
	/** Frozen-but-signed content on halted/forked/aborted; null on absent. */
	text: string | null;
	/** Deterministic state line; null when the chain fully resolved. */
	banner: string | null;
}

export interface Dossier {
	subject: NostrEvent;
	subjectType: 'product' | 'metadata';
	retracted: boolean;
	title: DossierTitle;
	/** AI description, products only, cache-only — undefined on miss. */
	snippet: string | undefined;
	identifiers: string[];
	publisher: string;
	createdAt: number;
	/** Section counts (spec §2 rule 2): every count equals rows rendered.
	 * summary = identifier chips; history = all History rows; files = Files. */
	counts: { summary: number; history: number; files: number };
	content: DossierContent;
	history: HistoryRow[];
	files: FileRow[];
}

function pluralize(n: number, word: string): string {
	return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

function contentOf(resolution: Resolution): DossierContent {
	const chain = resolution.chain;
	switch (chain.status) {
		case 'resolved':
			return { text: chain.content, banner: null };
		case 'halted':
			// applied.length = patches that made it in; the content truth
			// stops there — the banner names the freeze point, never hides it.
			return {
				text: chain.content,
				banner:
					chain.applied.length === 0
						? 'halted — content is the unpatched root'
						: `halted after ${pluralize(chain.applied.length, 'patch')} — content frozen at the last good state`
			};
		case 'forked':
			return {
				text: chain.content,
				banner: 'forked — content frozen at the shared parent'
			};
		case 'aborted':
			// §5.4: a resource ceiling is never surfaced as a HALT.
			return {
				text: chain.content,
				banner:
					chain.applied.length === 0
						? `stopped at limit before any patch applied · ${chain.limit}`
						: `stopped at limit after ${pluralize(chain.applied.length, 'patch')} · ${chain.limit}`
			};
		case 'absent':
			return {
				text: null,
				banner:
					chain.reason === 'root-unobserved'
						? 'no content — the root event is not in this result set'
						: 'no content — this event is not a patchable root'
			};
	}
}

/** Honoured retractions of the subject (DEL-1: kind-5, same pubkey, e-tag). */
function retractionOf(subject: NostrEvent, events: NostrEvent[]): NostrEvent | undefined {
	const deletions = events.filter((e) => e.kind === DELETION_KIND);
	if (!isDefaultViewRetracted(subject as never, deletions as never)) return undefined;
	return deletions.find(
		(d) => d.pubkey === subject.pubkey && tagValues(d, 'e').includes(subject.id)
	);
}

function historyRows(
	subject: NostrEvent,
	resolution: Resolution,
	events: NostrEvent[]
): HistoryRow[] {
	const byId = new Map(events.map((e) => [e.id, e]));
	const rows: HistoryRow[] = [];
	const rootEvent = byId.get(subject.id) ?? subject;
	rows.push({
		id: subject.id,
		author: rootEvent.pubkey,
		createdAt: rootEvent.created_at,
		position: 0,
		state: 'root',
		canonical: true
	});

	const chain = resolution.chain;
	if (chain.status === 'resolved' || chain.status === 'halted' || chain.status === 'aborted') {
		chain.applied.forEach((id, i) => {
			const ev = byId.get(id);
			rows.push({
				id,
				author: ev?.pubkey ?? '',
				createdAt: ev?.created_at ?? 0,
				position: i + 1,
				state: 'applied',
				canonical: true
			});
		});
	}
	if (chain.status === 'halted') {
		const ev = byId.get(chain.haltedAt);
		rows.push({
			id: chain.haltedAt,
			author: ev?.pubkey ?? '',
			createdAt: ev?.created_at ?? 0,
			position: chain.applied.length + 1,
			state: 'halted-here',
			canonical: true
		});
	}
	if (chain.status === 'forked') {
		const parent = byId.get(chain.forkParentId);
		rows.push({
			id: chain.forkParentId,
			author: parent?.pubkey ?? '',
			createdAt: parent?.created_at ?? 0,
			position: null,
			state: 'fork-parent',
			canonical: true
		});
		for (const id of chain.branchIds) {
			const ev = byId.get(id);
			rows.push({
				id,
				author: ev?.pubkey ?? '',
				createdAt: ev?.created_at ?? 0,
				position: null,
				state: 'fork-branch',
				canonical: false
			});
		}
	}

	// Non-canonical group (issue #29 ruling 5): root-author pending patches,
	// then foreign overlays carrying their §7.3 state word.
	for (const id of resolution.pending) {
		const ev = byId.get(id);
		rows.push({
			id,
			author: ev?.pubkey ?? '',
			createdAt: ev?.created_at ?? 0,
			position: null,
			state: 'pending',
			canonical: false
		});
	}
	for (const overlay of resolution.overlays) {
		const ev = byId.get(overlay.id);
		rows.push({
			id: overlay.id,
			author: ev?.pubkey ?? overlay.author,
			createdAt: ev?.created_at ?? 0,
			position: null,
			state: 'overlay',
			overlayState: overlay.state,
			targetId: overlay.targetId,
			canonical: false
		});
	}

	// The retraction event is its own row, always with the red pill.
	const retraction = retractionOf(subject, events);
	if (retraction !== undefined) {
		rows.push({
			id: retraction.id,
			author: retraction.pubkey,
			createdAt: retraction.created_at,
			position: null,
			state: 'retraction',
			canonical: true
		});
	}
	return rows;
}

/** Files rows scan ADMITTED bindings directly — deliberately NOT
 * graph.edges (resolveGraph drops bindings whose counterparty isn't in the
 * batch, a drawing convenience, not evidence judgment). Divergence from the
 * card footer's "N metadata" (graph-derived, both-endpoints-present only) is
 * intentional: a delivered binding is evidence even when its other end
 * wasn't fetched; the footer count reads as "bound metadata in this result
 * set", the dossier count reads as "bindings referencing this event". */
function fileRows(subjectId: string, events: NostrEvent[], cards: ProductCard[]): FileRow[] {
	const byId = new Map(events.map((e) => [e.id, e]));
	const rows: FileRow[] = [];
	for (const event of events) {
		if (scrutinyEventType(event as never) !== 'binding') continue;
		const endpoints = bindingEndpoints(event as never);
		if (endpoints === undefined) continue;
		if (endpoints.rootId !== subjectId && endpoints.linkId !== subjectId) continue;
		const counterpartyId = endpoints.rootId === subjectId ? endpoints.linkId : endpoints.rootId;
		const counterparty = byId.get(counterpartyId);
		const card = cards.find((c) => c.id === counterpartyId);
		rows.push({
			bindingId: event.id,
			verb: event.content.trim(),
			counterpartyId,
			counterpartyLabel:
				card !== undefined && card.interpreted
					? card.title
					: counterparty !== undefined
						? deriveFallbackTitle(counterparty)
						: null,
			destination: endpoints.rootId === subjectId ? 'subject' : 'counterparty'
		});
	}
	return rows;
}

/** The drawer's data contract. `events` is the session's admitted set (the
 * store, never the facet-filtered view — ADR 0001); `cards` is the
 * interpretations cache's materialized face. Returns null when the subject
 * is not in the admitted set at all. */
export function deriveDossier(
	subjectId: string,
	events: NostrEvent[],
	cards: ProductCard[]
): Dossier | null {
	const subject = events.find((e) => e.id === subjectId);
	if (subject === undefined) return null;
	const type = scrutinyEventType(subject as never);
	if (type !== 'product' && type !== 'metadata') return null;

	const card = cards.find((c) => c.id === subjectId);
	const interpreted = card !== undefined && card.interpreted;
	const resolution = resolve(subjectId, events as never);
	const content = contentOf(resolution);
	const history = historyRows(subject, resolution, events);
	const files = fileRows(subjectId, events, cards);
	const identifiers = [...new Set(tagValues(subject, 'i'))];

	return {
		subject,
		subjectType: type,
		retracted: retractionOf(subject, events) !== undefined,
		title: {
			text: interpreted && card !== undefined ? card.title : deriveFallbackTitle(subject),
			interpreted
		},
		// Descriptions are products-only (BIBLE N1 ④) and cache-only.
		snippet: type === 'product' && interpreted ? card?.snippet : undefined,
		identifiers,
		publisher: subject.pubkey,
		createdAt: subject.created_at,
		counts: { summary: identifiers.length, history: history.length, files: files.length },
		content,
		history,
		files
	};
}
