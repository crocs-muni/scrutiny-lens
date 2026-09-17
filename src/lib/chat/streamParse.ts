/**
 * Streaming chat parser (issue #30, ruling 5 — pending-shimmer design;
 * scanner cutover 2026-09-17).
 *
 * The model's raw marker syntax `[N]{"eventId":"…","quote":"…"}` must never
 * flash on screen mid-stream (citations are computed, not model-fabricated —
 * G1). Complete markers become NEUTRAL shimmer placeholders; a tail that
 * could still grow into a marker is withheld outright, so half-written JSON
 * never renders. Withholding ends as soon as one non-marker character makes
 * completion impossible — the stream only appends, so `…[1] x` can never
 * become a marker and renders as literal prose.
 *
 * Detection reuses $lib/chat/markers's scanMarkers (single owner): a
 * balanced-brace, string-aware read — the flat `[^{}]*` capture that used
 * to live here leaked nested-brace payloads onto the live surface (PQC
 * chat, 2026-09-17). Malformed/unterminated braced runs are withheld just
 * like partial ones; what a corrupt payload must never do is render.
 *
 * Stateless by contract: callers re-parse the whole accumulated string on
 * each delta. Settle-time resolution (verified pills or STRIP, user ruling
 * 2026-09-17) happens elsewhere; this file only protects the live surface.
 */

import { scanMarkers, type MarkerScan } from './markers';

export type StreamSegment =
	| { kind: 'prose'; text: string }
	| { kind: 'pending'; n: number | null };

/** A tail that could still grow into the `[N]` half of a marker: `[`,
 * `[12`, `[1]`, `[1] `, `[1] {` — before any closing bracket. */
const WITHHELD_TAIL = /^\[\d*(\](\s*(\{[^{}]*)?)?)?$/;

/** Payload → pinned number, or null for unparseable payloads / ids the pin
 * refuses. A malformed payload carries no trustworthy id, so its shimmer
 * shows no number (same contract as the old parse-shim). */
function pinOf(scan: MarkerScan, pin: (eventId: string) => number | null): number | null {
	if (scan.objectText === null) return null;
	try {
		const payload: unknown = JSON.parse(scan.objectText);
		if (
			typeof payload === 'object' &&
			payload !== null &&
			typeof (payload as { eventId?: unknown }).eventId === 'string' &&
			(payload as { eventId: string }).eventId.length > 0
		) {
			return pin((payload as { eventId: string }).eventId);
		}
	} catch {
		// balanced but not our payload shape — numberless shimmer
	}
	return null;
}

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

	for (const scan of scanMarkers(text)) {
		if (!scan.braced) {
			// Bare canonical [N]: the model echoed a number with no payload.
			// It can still grow into a full `[N]{…}` ONLY when everything
			// after it is whitespace (the stream appends) — withhold; any
			// non-space character makes completion impossible and it stays
			// inside the prose span (then settle owns its fate, never us).
			if (text.slice(scan.end).trim() === '') {
				if (scan.start > cursor) segments.push({ kind: 'prose', text: text.slice(cursor, scan.start) });
				return segments;
			}
			continue;
		}
		if (scan.start > cursor) segments.push({ kind: 'prose', text: text.slice(cursor, scan.start) });
		if (scan.objectText === null) {
			// Two distinct hides: an UNTERMINATED run withholds silently —
			// the stream may still complete it, and a half-written object
			// never even shimmers. A corrupt COMPLETE run shows the
			// numberless pending shimmer: settled shape reached, payload
			// dead — but corrupt JSON itself must never render.
			if (!scan.terminated) return segments;
			segments.push({ kind: 'pending', n: pinOf(scan, pin) });
			cursor = scan.end;
			continue;
		}
		segments.push({ kind: 'pending', n: pinOf(scan, pin) });
		cursor = scan.end;
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
