/**
 * W5 · Citation registry — stable per-session [N] numbering + resolution.
 *
 * Deterministic, no LLM. The registry owns citation numbers for one session:
 *
 *   - `next(eventId)` pins a monotonic number per event id — the same event
 *     always resolves to the same [N] for the whole conversation (view-models
 *     §3.7: "stable per-conversation"; also drives the color pairing).
 *   - `resolve(marker, events, quote)` turns a `[N]` marker or an eventId
 *     into a Citation. The quote is verified against the event content via
 *     the extracted gate: verbatim and blockquote-subset partials count as
 *     verified; extrapolatory quotes are reported unverified with the gate's
 *     state visible to callers.
 *   - Locked rule: every [N] marker MUST resolve to a visible-node eventId —
 *     anything else comes back `unresolvable` and callers drop it on final
 *     parse; numbers are never re-purposed.
 */

import { extractedGate } from './verifier';
import type { NostrEvent } from '../fabric';

/** Canonical Citation (docs/types.md §Citation), plus the resolver's matched span. */
export interface Citation {
	/** Stable citation number (per-session). */
	n: number;
	/** The event id cited. */
	eventId: string;
	/** Candidate quote the assistant offered for the claim it sits beside. */
	quote: string;
	/** True when the quote matched verbatim or as a blockquote-subset partial. */
	verified: boolean;
	/** The node's display title (for hovercards). */
	nodeTitle?: string;
	/** The normalized span actually matched in the event content. */
	span?: string;
}

export type ResolveResult =
	| { ok: true; citation: Citation }
	| { ok: false; marker: number | string; reason: 'unresolvable' };

export interface CitationRegistry {
	/** Pin (or recall) the stable number for an eventId. Monotonic. */
	next(eventId: string): number;
	/** Number of events pinned so far. */
	size(): number;
	/** Inverse lookup: which eventId owns number n (undefined if never pinned). */
	eventIdFor(n: number): string | undefined;
	/**
	 * Resolve a marker — a citation number (3 or '[3]') or an eventId — against
	 * the visible events. An unseen-but-visible eventId is pinned on resolve
	 * (numbers stay stable afterwards). Returns `unresolvable` when the marker
	 * points at nothing visible.
	 */
	resolve(
		marker: number | string,
		events: NostrEvent[],
		quote?: string,
		nodeTitle?: string
	): ResolveResult;
}

const NUMERIC_MARKER = /^\[?(\d+)\]?$/;

export function createCitationRegistry(): CitationRegistry {
	const byEvent = new Map<string, number>();
	const byN = new Map<number, string>();

	function next(eventId: string): number {
		const seen = byEvent.get(eventId);
		if (seen !== undefined) return seen;
		const n = byEvent.size + 1;
		byEvent.set(eventId, n);
		byN.set(n, eventId);
		return n;
	}

	function resolve(
		marker: number | string,
		events: NostrEvent[],
		quote = '',
		nodeTitle?: string
	): ResolveResult {
		let eventId: string | undefined;

		if (typeof marker === 'number' && Number.isInteger(marker)) {
			eventId = byN.get(marker);
		} else {
			const s = String(marker).trim();
			const numeric = NUMERIC_MARKER.exec(s);
			if (numeric) {
				eventId = byN.get(Number.parseInt(numeric[1], 10));
			} else if (byEvent.has(s)) {
				eventId = s;
			} else if (events.some((e) => e.id === s)) {
				// Visible but never pinned: pin now so the number is stable.
				next(s);
				eventId = s;
			}
		}

		if (eventId === undefined) return { ok: false, marker, reason: 'unresolvable' };
		const event = events.find((e) => e.id === eventId);
		if (event === undefined) {
			// Every [N] MUST resolve to a visible-node eventId.
			return { ok: false, marker, reason: 'unresolvable' };
		}

		const match = extractedGate(quote, event.content);
		const citation: Citation = {
			n: byEvent.get(eventId) as number,
			eventId,
			quote,
			verified: match.state !== 'extrapolatory'
		};
		if (match.span !== undefined) citation.span = match.span;
		if (nodeTitle !== undefined) citation.nodeTitle = nodeTitle;
		return { ok: true, citation };
	}

	return { next, size: () => byEvent.size, eventIdFor: (n) => byN.get(n), resolve };
}
