/**
 * W3 · AI pipeline core — deterministic source-of-truth verification gates.
 * No LLM dependency. These gates decide whether an AI-claimed fact matches the
 * underlying event, mapping to the provenance vocabulary in docs (source union:
 * tag / extracted / interpreted / derived).
 */

import type { NostrEvent } from '../fabric';

/** Provenance source literal union (docs/view-models.md provenance column). */
export type VerificationSource = 'tag' | 'extracted' | 'interpreted' | 'derived';

const WS = /\s+/;

/** Collapse all whitespace runs to single spaces and trim (verbatim normalization). */
function normalize(s: string): string {
	return s.trim().split(WS).join(' ');
}

/**
 * tagGate — is `field` an exact match against any value slot of any tag on the
 * event? The tag's key (slot 0) is excluded; only value slots (1..n) count.
 * Provenance: tag.
 */
export function tagGate(field: string, event: NostrEvent): boolean {
	if (!field) return false;
	return event.tags.some((tag) => tag.slice(1).some((v) => v === field));
}

export type ExtractionState = 'verbatim' | 'partial' | 'extrapolatory';

export interface ExtractionMatch {
	state: ExtractionState;
	/** The matched content span (normalized) for verbatim/partial. */
	span?: string;
}

/**
 * Longest contiguous run (≥2 words) of the normalized quote that appears as a
 * contiguous substring of the normalized content. Used for blockquote-subset
 * support — a subset of the claimed quote is actually present on the event.
 */
function longestContiguousMatch(nq: string, nc: string): string | undefined {
	const words = nq.split(' ');
	for (let len = words.length; len >= 2; len--) {
		for (let start = 0; start + len <= words.length; start++) {
			const run = words.slice(start, start + len).join(' ');
			if (nc.includes(run)) return run;
		}
	}
	return undefined;
}

/**
 * extractedGate — how well does `quote` match `content`?
 *   verbatim      → normalized quote is a contiguous substring of normalized content
 *   partial       → a ≥2-word contiguous subset of the quote appears in the content
 *                   (blockquote-lift subset counts as support), with the span returned
 *   extrapolatory → nothing usable found (never quote-gated)
 */
export function extractedGate(quote: string, content: string): ExtractionMatch {
	const nq = normalize(quote);
	const nc = normalize(content);
	if (nq && nc.includes(nq)) return { state: 'verbatim', span: nq };
	const span = longestContiguousMatch(nq, nc);
	if (span) return { state: 'partial', span };
	return { state: 'extrapolatory' };
}
