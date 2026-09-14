/**
 * Chat answer settle gates (issue #30, ADR 0003) — the deterministic pair the
 * renderer trusts:
 *
 *   scrubAnswer  — removes markers whose citation FAILED verbatim
 *                  verification. Nothing unverified may leave a trace: no
 *                  pill, no [N], no claim underline. Markers with no matching
 *                  citation at all stay as literal inert text (AI-Elements'
 *                  unmatched-marker precedent) because the scrub can only
 *                  delete what it can prove failed.
 *
 *   layoutAnswer — splits settled content into text runs carrying the
 *                  citation numbers whose claim span covers them, plus pill
 *                  parts at verified marker positions. A claim span is the
 *                  sentence containing the marker (terminator-inclusive) —
 *                  the interactive, dotted-underlined region. Spans of
 *                  markers in one sentence merge: the run carries every
 *                  covering number and the renderer pairs colors on the first.
 */

/** A run of prose, or a citation pill, in reading order. */
export type AnswerPart =
	| { kind: 'text'; text: string; marks: number[] }
	| { kind: 'pill'; n: number; marks: number[] };

const CANON_MARKER = /\[(\d+)\]/g;
const TERMINATORS = new Set(['.', '!', '?', '\n']);

/* ------------------------------------------------------------------ *
 * scrubAnswer
 * ------------------------------------------------------------------ */

/** Marker minus the citation triage: the agent's final frame carries the
 * full flag set; callers pass it through unchanged. */
export interface ScrubCitation {
	n: number;
	verified: boolean;
}

export function scrubAnswer<T extends ScrubCitation>(
	content: string,
	citations: T[]
): { content: string; citations: T[] } {
	const failed = new Set(citations.filter((c) => !c.verified).map((c) => c.n));
	// Only markers PROVEN failed vanish — with one adjacent space so no
	// orphan whitespace remains. Everything else (verified citations, bare
	// [N] with no citation record) is literal text. Regex derived from
	// CANON_MARKER so the token grammar lives in exactly one place.
	const text = content.replace(new RegExp(` ?${CANON_MARKER.source}`, 'g'), (raw, nRaw: string) =>
		failed.has(Number(nRaw)) ? '' : raw
	);
	return { content: text, citations: citations.filter((c) => c.verified) };
}

/* ------------------------------------------------------------------ *
 * layoutAnswer
 * ------------------------------------------------------------------ */

interface Span {
	start: number;
	end: number; // exclusive
	n: number;
}

interface Pill {
	index: number;
	end: number;
	n: number;
}

/** Sentence span for a marker token: back to (but excluding) the previous
 * terminator; forward THROUGH the next terminator (the underline lands on
 * the sentence's period), leading whitespace trimmed, trailing spaces after
 * the terminator riding inside so the region reads as one block. */
function sentenceSpan(text: string, tokenStart: number, tokenEnd: number): { start: number; end: number } {
	let start = 0;
	for (let i = tokenStart - 1; i >= 0; i--) {
		if (TERMINATORS.has(text[i])) {
			start = i + 1;
			break;
		}
	}
	while (start < tokenStart && /\s/.test(text[start])) start++;
	let end = tokenEnd;
	while (end < text.length && !TERMINATORS.has(text[end])) end++;
	if (end < text.length) end++; // terminator included
	while (end < text.length && text[end] === ' ') end++;
	return { start, end };
}

/** `verified` is optional: persisted citations are post-scrub by
 * construction (ADR 0003), so an absent flag means verified. */
export function layoutAnswer(
	content: string,
	citations: { n: number; verified?: boolean }[]
): AnswerPart[] {
	const verified = new Set(citations.filter((c) => c.verified !== false).map((c) => c.n));
	const spans: Span[] = [];
	const pills: Pill[] = [];
	for (const m of content.matchAll(CANON_MARKER)) {
		const n = Number(m[1]);
		if (!verified.has(n)) continue;
		const index = m.index ?? 0;
		const end = index + m[0].length;
		spans.push({ ...sentenceSpan(content, index, end), n });
		pills.push({ index, end, n });
	}
	if (pills.length === 0) {
		return content.length > 0 ? [{ kind: 'text', text: content, marks: [] }] : [];
	}

	const marksAt = (i: number): number[] =>
		spans
			.filter((s) => s.start <= i && i < s.end)
			.map((s) => s.n)
			.sort((a, b) => a - b);

	const parts: AnswerPart[] = [];
	/** Emit [a,b) as uniform-coverage text runs, splitting at span boundaries. */
	const pushText = (a: number, b: number): void => {
		if (a >= b) return;
		let runStart = a;
		let marks = marksAt(a);
		for (let i = a + 1; i < b; i++) {
			const next = marksAt(i);
			if (next.length !== marks.length || next.some((n, j) => n !== marks[j])) {
				parts.push({ kind: 'text', text: content.slice(runStart, i), marks });
				runStart = i;
				marks = next;
			}
		}
		parts.push({ kind: 'text', text: content.slice(runStart, b), marks });
	};

	let cursor = 0;
	for (const pill of pills) {
		pushText(cursor, pill.index);
		parts.push({ kind: 'pill', n: pill.n, marks: marksAt(pill.index) });
		cursor = pill.end;
	}
	pushText(cursor, content.length);
	return parts;
}
