/**
 * Streaming chat parser (issue #30; scanner cutover 2026-09-17; #134 pill
 * cutover 2026-11-21).
 *
 * The model's raw marker syntax `[N]{"eventId":"…","quote":"…"}` must never
 * flash on screen mid-stream (citations are computed, not model-fabricated —
 * G1). This module owns ONE decision: how much of the accumulated stream is
 * READABLE — the largest prefix that can no longer grow into a marker.
 * Withholding ends as soon as one non-marker character makes completion
 * impossible — the stream only appends, so `…[1] x` can never become a marker
 * and renders as literal prose.
 *
 * What the readable prefix is SETTLED into is not this file's job: complete
 * markers in it are final claims, and chat/settle.ts runs the transcript's own
 * quote gate over them (#134), so each closed claim carries its own verdict
 * mid-stream and the unterminated tail stays plain. Trust is never decided
 * here.
 *
 * Detection reuses $lib/chat/markers's scanMarkers (single owner): a
 * balanced-brace, string-aware read — the flat `[^{}]*` capture that used to
 * live here leaked nested-brace payloads onto the live surface (PQC chat,
 * 2026-09-17). Malformed/unterminated braced runs are withheld just like
 * partial ones; what a corrupt payload must never do is render.
 *
 * Stateless by contract: callers re-parse the whole accumulated string on
 * each delta.
 */

import { scanMarkers } from './markers';

/** A tail that could still grow into the `[N]` half of a marker: `[`,
 * `[12`, `[1]`, `[1] `, `[1] {` — before any closing bracket. */
const WITHHELD_TAIL = /^\[\d*(\](\s*(\{[^{}]*)?)?)?$/;

/** The accumulated stream up to the first character that could still become
 * part of a marker. Never longer than `text`, never shorter than the last
 * complete marker's end. */
export function readablePrefix(text: string): string {
	let cursor = 0;
	for (const scan of scanMarkers(text)) {
		if (!scan.braced) {
			// Bare canonical [N]: the model echoed a number with no payload.
			// It can still grow into a full `[N]{…}` ONLY when everything
			// after it is whitespace (the stream appends) — withhold; any
			// non-space character makes completion impossible and it stays
			// inside the readable text (then settle owns its fate, never us).
			if (text.slice(scan.end).trim() === '') return text.slice(0, scan.start);
			continue;
		}
		// Half-written object: the stream may still complete it, and a
		// half-written object must never even show a placeholder.
		if (!scan.terminated) return text.slice(0, scan.start);
		cursor = scan.end;
	}

	// Tail: withhold iff it can still complete into a marker.
	const rest = text.slice(cursor);
	const lastBracket = rest.lastIndexOf('[');
	if (lastBracket >= 0 && WITHHELD_TAIL.test(rest.slice(lastBracket))) {
		return text.slice(0, cursor + lastBracket);
	}
	return text;
}
