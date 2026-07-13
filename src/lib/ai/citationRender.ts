// Turns a chat answer's citation markup into interactive UI.
//
// Earlier version: the model wrapped its own cited clause in [[cN]]...[[/cN]]
// tags at generation time, letting us mark the exact span it wrote with zero
// fuzzy matching. Dropped after two straight real-world failures where the
// model got the wrap/pill number pairing wrong (once mismatched, once used a
// full event id as the wrap number) -- showing broken bracket-tag text is
// worse than a coarser-but-always-correct mark. [N] pill markers alone are
// what the model reliably gets right, so that's now the only thing it has to
// produce; the marked clause is derived deterministically from each pill's
// position -- no model cooperation, no malformed-tag failure mode.
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import type { Citation } from './types.js';

function escapeAttr(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const MARK_START = (n: number) => `[[MARK_START_${n}]]`;
const MARK_END = (n: number) => `[[MARK_END_${n}]]`;
const CITE_TOKEN = (n: number) => `[[CITE_TOKEN_${n}]]`;

function pillHtml(n: number, id: string, quote: string, verified: boolean): string {
	const title = quote ? escapeAttr(quote.slice(0, 200)) : '';
	return `<span class="citation-pill" role="button" tabindex="0" data-citation="${n}" data-citation-id="${escapeAttr(id)}" data-citation-quote="${title}" data-citation-verified="${verified ? '1' : '0'}">[${n}]</span>`;
}

/**
 * Renders a chat answer's markdown, converting each [N] pill marker (for a
 * number actually present in `citations`) into a clickable/hoverable pill,
 * and marking the clause leading up to it: everything back to the previous
 * sentence boundary (. ! ?) or the previous marked citation, whichever comes
 * later. Consecutive citations in the same sentence each get their own
 * non-overlapping clause. Markers not in `citations` (stray bracket-number
 * text, or a marker the trailing JSON never resolved) are left as plain text.
 */
export function renderMarkdownWithCitations(
	markdown: string,
	citations: Array<Citation & { verified?: boolean }> = []
): string {
	const byNumber = new Map(citations.map((c) => [c.n, c]));

	let tokenized = '';
	let lastIndex = 0;
	let clauseStart = 0;
	const markerPattern = /\[(\d+)\]/g;
	let match: RegExpExecArray | null;

	while ((match = markerPattern.exec(markdown))) {
		const n = Number(match[1]);
		if (!byNumber.has(n)) continue;

		const markerStart = match.index;
		const markerEnd = markerStart + match[0].length;

		// Find the last sentence-ending punctuation between this clause's
		// start and the marker -- the clause is whatever comes after it (or
		// the whole span back to clauseStart, if the sentence started there).
		const segment = markdown.slice(clauseStart, markerStart);
		const sentenceEnds = [...segment.matchAll(/[.!?]\s+/g)];
		const lastEnd = sentenceEnds.at(-1);
		const thisClauseStart = lastEnd ? clauseStart + lastEnd.index! + lastEnd[0].length : clauseStart;

		tokenized += markdown.slice(lastIndex, thisClauseStart);
		tokenized += MARK_START(n);
		tokenized += markdown.slice(thisClauseStart, markerStart);
		tokenized += MARK_END(n);
		tokenized += CITE_TOKEN(n);

		lastIndex = markerEnd;
		clauseStart = markerEnd;
	}
	tokenized += markdown.slice(lastIndex);

	let html = DOMPurify.sanitize(marked.parse(tokenized, { async: false }) as string);

	for (const c of citations) {
		html = html.split(MARK_START(c.n)).join(`<mark class="cited-mark" data-citation="${c.n}">`);
		html = html.split(MARK_END(c.n)).join('</mark>');
		html = html.split(CITE_TOKEN(c.n)).join(pillHtml(c.n, c.id, c.quote, c.verified ?? false));
	}

	return html;
}

/**
 * Verifies a citation's quote against the real (uncapped) content of the
 * event it claims to cite -- exact substring match only, whitespace
 * normalized. No fuzzy fallback: if the model didn't quote verbatim, showing
 * a guessed approximate span would be worse than honestly saying so.
 */
export function verifyQuote(eventContent: string, quote: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
	const needle = norm(quote);
	if (!needle) return false;
	return norm(eventContent).includes(needle);
}
