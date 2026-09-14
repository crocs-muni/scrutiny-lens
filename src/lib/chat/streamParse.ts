/**
 * Streaming chat parser (issue #30, ruling 5 — pending-shimmer design).
 *
 * The model's raw marker syntax `[N]{"eventId":"…","quote":"…"}` must never
 * flash on screen mid-stream (citations are computed, not model-fabricated —
 * G1). Complete markers become NEUTRAL shimmer placeholders; a tail that
 * could still grow into a marker is withheld outright, so half-written JSON
 * never renders. Withholding ends as soon as one non-marker character makes
 * completion impossible — the stream only appends, so `…[1] x` can never
 * become a marker and renders as literal prose (AI-Elements' inert-marker
 * precedent).
 *
 * Stateless by contract: callers re-parse the whole accumulated string on
 * each delta. Settle-time resolution (verified pills or silent drops, ADR
 * 0003) happens elsewhere; this file only protects the live surface.
 */

import { MARKER as COMPLETE_MARKER } from '$lib/ai/agents/chat';

export type StreamSegment =
	| { kind: 'prose'; text: string }
	| { kind: 'pending'; n: number | null };

/** COMPLETE_MARKER is imported from the agent (not re-declared) so the live
 * surface and the settle gate share one marker-grammar source of truth,
 * payload capture group included (standards review P2). */

/** A tail that could still grow into a marker: `[`, `[12`, `[1]`, `[1] `,
 * `[1] {`, `[1] {"eventId":"ev…` (partial JSON included). */
const WITHHELD_TAIL = /^\[\d*(\](\s*(\{[^{}]*)?)?)?$/;

/**
 * Parse accumulated raw stream text into render-safe segments.
 * `pin(eventId)` reserves the eager per-conversation number for a complete
 * marker — called at most once per complete marker occurrence, left to
 * right, and ONLY for payloads carrying a non-empty string eventId. Its
 * return (null for ids outside the grounding set) never throws: a
 * fabricated id renders the same neutral shimmer minus number.
 */
export function parseChatStream(
	text: string,
	pin: (eventId: string) => number | null
): StreamSegment[] {
	const segments: StreamSegment[] = [];
	let cursor = 0;

	for (const match of text.matchAll(COMPLETE_MARKER)) {
		const index = match.index ?? 0;
		if (index > cursor) segments.push({ kind: 'prose', text: text.slice(cursor, index) });

		let n: number | null = null;
		try {
			const payload: unknown = JSON.parse(`{${match[2]}}`);
			if (
				typeof payload === 'object' &&
				payload !== null &&
				typeof (payload as { eventId?: unknown }).eventId === 'string' &&
				((payload as { eventId: string }).eventId as string).length > 0
			) {
				n = pin((payload as { eventId: string }).eventId);
			}
		} catch {
			// Malformed payload: shimmer carries no number — the pin is never
			// consulted because there is no trustworthy id to pin against.
		}
		segments.push({ kind: 'pending', n });
		cursor = index + match[0].length;
	}

	// Tail: withhold iff it can still complete into a marker.
	const rest = text.slice(cursor);
	if (rest !== '') {
		const lastBracket = rest.lastIndexOf('[');
		const tail = lastBracket >= 0 ? rest.slice(lastBracket) : '';
		if (tail !== '' && WITHHELD_TAIL.test(tail)) {
			if (lastBracket > 0) segments.push({ kind: 'prose', text: rest.slice(0, lastBracket) });
			// else: the whole remainder is the withheld tail — nothing emitted
		} else {
			segments.push({ kind: 'prose', text: rest });
		}
	}
	return segments;
}
