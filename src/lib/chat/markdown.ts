/**
 * Chat markdown owner (chat-output rework T2, 2026-09-17).
 *
 * ONE pipeline for both the live stream and the settled message: prose runs
 * become blocks (paragraph / bullet list / numbered list / code fence);
 * block bodies go through marked-inline + DOMPurify — the same sanitizer
 * the hard rule in spec §6 requires on every {@html} path.
 *
 * Why not marked.parse (full block parse) across the whole answer: citation
 * pills are Svelte components interleaved between prose runs. A whole-document
 * {@html} paste would have to split HTML fragments across component slots,
 * and fragments split mid-`<ul>` render broken. Runs are split at pill
 * boundaries FIRST (layoutAnswer / parseChatStream own that), then each run
 * blockifies independently — an item's body always starts and ends inside
 * one run, so every pasted HTML fragment is balanced.
 *
 * The previous renderer used marked.parseInline for everything: list
 * markers like `* ` are BLOCK syntax and rendered as literal asterisks on
 * screen (live complaint, PQC chat). List markers parsed here, once.
 *
 * Grammar (line-based, additive):
 *   ``` fenced blocks → code block (language class echoed, content escaped)
 *   `* `/`- `/`+ ` runs → <ul>, `${n}. ` runs → <ol>
 *   anything else → paragraph text, joined with '\n'
 * Unknown markdown features degrade to parseInline inside their paragraph —
 * never garbage, never stripped.
 */

import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

export type ChatBlock =
	| { kind: 'paragraph'; text: string }
	| { kind: 'bullets'; items: string[] }
	| { kind: 'numbered'; items: string[] }
	| { kind: 'code'; lang: string; text: string };

const BULLET = /^[*+-]\s+/;
const ORDERED = /^\d+\.\s+/;

/** marked-inline + DOMPurify — the single sanitizer THE app is allowed to
 * hand a raw string, and the single HTML form the renderer pastes. */
export function inlineHtml(text: string): string {
	return DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string);
}

/** Escape fence bodies: code is machine text and must render literally. */
export function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function parseBlocks(text: string): ChatBlock[] {
	const blocks: ChatBlock[] = [];
	let paragraph: string[] = [];
	let list: { kind: 'bullets' | 'numbered'; items: string[] } | null = null;
	let fence: { lang: string; lines: string[] } | null = null;

	const flushParagraph = (): void => {
		if (paragraph.length > 0) {
			blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
			paragraph = [];
		}
	};
	const flushList = (): void => {
		if (list !== null) {
			blocks.push({ kind: list.kind, items: list.items });
			list = null;
		}
	};

	for (const line of text.split('\n')) {
		if (fence !== null) {
			if (line.trim().startsWith('```')) {
				blocks.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
				fence = null;
			} else {
				fence.lines.push(line);
			}
			continue;
		}
		const fenceStart = /^```(\w*)\s*$/.exec(line.trim());
		if (fenceStart !== null) {
			flushParagraph();
			flushList();
			fence = { lang: fenceStart[1] ?? '', lines: [] };
			continue;
		}
		if (BULLET.test(line)) {
			flushParagraph();
			if (list === null || list.kind !== 'bullets') {
				flushList();
				list = { kind: 'bullets', items: [] };
			}
			list.items.push(line.replace(BULLET, ''));
			continue;
		}
		if (ORDERED.test(line)) {
			flushParagraph();
			if (list === null || list.kind !== 'numbered') {
				flushList();
				list = { kind: 'numbered', items: [] };
			}
			list.items.push(line.replace(ORDERED, ''));
			continue;
		}
		if (line.trim() === '') {
			flushParagraph();
			flushList();
			continue;
		}
		flushList();
		paragraph.push(line);
	}
	if (fence !== null) blocks.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
	flushParagraph();
	flushList();
	return blocks;
}
