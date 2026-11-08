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
 *   |a|b| + |---|---| rows → table (cells inline-parsed; alignment echoed)
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
	| { kind: 'code'; lang: string; text: string }
	/** GFM table. `align` is per column; null = default (left). */
	| { kind: 'table'; header: string[]; rows: string[][]; align: (TableAlign | null)[] };

export type TableAlign = 'left' | 'center' | 'right';

const BULLET = /^[*+-]\s+/;
const ORDERED = /^\d+\.\s+/;
const HEADING = /^#{1,6}\s/;
const BLOCKQUOTE = /^>/;
/** A GFM delimiter row: at least two columns, or one fully piped column. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const TABLE_SEPARATOR_ONE = /^\s*\|\s*:?-+:?\s*\|\s*$/;

/** Split one GFM row. Escaped `\|` and code spans stay inside the cell. */
function splitTableRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
	const cells: string[] = [];
	let current = '';
	/** 0 = not in code; otherwise the opening backtick-run length. */
	let codeTicks = 0;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (ch === '\\' && row[i + 1] === '|') {
			current += '|';
			i++;
			continue;
		}
		if (ch === '`') {
			let run = 1;
			while (row[i + run] === '`') run++;
			if (codeTicks === 0) codeTicks = run;
			else if (run === codeTicks) codeTicks = 0;
			current += '`'.repeat(run);
			i += run - 1;
			continue;
		}
		if (ch === '|' && codeTicks === 0) {
			cells.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	cells.push(current.trim());
	return cells;
}

function tableAlign(cell: string): TableAlign | null {
	const left = cell.startsWith(':');
	const right = cell.endsWith(':');
	if (left && right) return 'center';
	if (right) return 'right';
	if (left) return 'left';
	return null;
}

/** A GFM table start at lines[i..i+1]; header and delimiter cell counts must
 * match (cmark-gfm's guard), else the lines stay paragraph text. */
function tableAt(
	lines: string[],
	i: number
): { header: string[]; align: (TableAlign | null)[] } | null {
	if (i + 1 >= lines.length || !lines[i].includes('|')) return null;
	const separator = lines[i + 1];
	if (!TABLE_SEPARATOR.test(separator) && !TABLE_SEPARATOR_ONE.test(separator)) return null;
	const header = splitTableRow(lines[i]);
	const delimiter = splitTableRow(separator);
	if (header.length !== delimiter.length) return null;
	return { header, align: delimiter.map(tableAlign) };
}

/** A body row ends at a blank line or any other block start, even when the
 * following block contains a pipe (models often omit the blank line). */
function isBlockStart(line: string): boolean {
	return (
		BULLET.test(line) ||
		ORDERED.test(line) ||
		HEADING.test(line) ||
		BLOCKQUOTE.test(line) ||
		line.trim().startsWith('```')
	);
}

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
	const lines = text.split('\n');

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

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
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
		const start = tableAt(lines, i);
		if (start !== null) {
			flushParagraph();
			flushList();
			const { header, align } = start;
			const rows: string[][] = [];
			let next = i + 2;
			for (; next < lines.length; next++) {
				const row = lines[next];
				if (row.trim() === '' || !row.includes('|') || isBlockStart(row)) break;
				const cells = splitTableRow(row);
				rows.push(header.map((_, column) => cells[column] ?? ''));
			}
			blocks.push({ kind: 'table', header, rows, align });
			i = next - 1;
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
