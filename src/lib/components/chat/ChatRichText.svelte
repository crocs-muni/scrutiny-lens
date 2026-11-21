<script lang="ts">
	/* The chat's ONE rich-text renderer (chat-output rework T2; #185 rewrite).
	 *
	 * The runs arrive split at every citation marker (layoutAnswer owns the
	 * verification gate), but BLOCKS are parsed once over the whole answer:
	 * text and marks are recombined into one string with sentinels before
	 * `parseBlocks` runs. Parsing each text run separately made a marker that
	 * ends a list item render as a sibling of the `<ul>` — a number floating
	 * on its own line under the bullet it belongs to — because the list had
	 * already been closed by the time the pill was emitted.
	 *
	 * Everything visual follows the #185 board: no permanent claim underline
	 * (the tint answers "which sentence" only while the mark or its source
	 * row is under the cursor), restored list markers, real headings, and a
	 * hairline table. */

	import { inlineHtml, parseBlocks, escapeHtml } from '$lib/chat/markdown';
	import { spotlight } from './spotlight.svelte';
	import CitationPill from './CitationPill.svelte';
	import type { AnswerPart } from '$lib/chat/answer';
	import type { PersistedChatCitation } from '$lib/db';

	/** One render unit: flat markdown text or a verified pill. The settle
	 * layout owns the vocabulary (chat/answer.ts); the live path feeds this
	 * same shape from the same layout (#134). */
	export type RichPart = AnswerPart;

	interface Props {
		parts: RichPart[];
		/** The verified citations the pills belong to — the settle layout's
		 * list, whether the answer is still streaming (#134) or landed. */
		citations?: PersistedChatCitation[];
		/** Which citation's register row is open (the turn owns it). */
		openN?: number | null;
		/** Absent while the answer streams: no register row exists yet, so the
		 * mark renders as a note instead of a control (#134). */
		onToggle?: (n: number) => void;
		/** Turn id — prefixes the register row ids so the mark can point at
		 * the row it expands (aria-controls) without colliding across turns. */
		idPrefix?: string;
	}

	let { parts, citations = [], openN = null, onToggle, idPrefix = 'turn' }: Props = $props();

	const byN = $derived(new Map(citations.map((c) => [c.n, c])));

	/** Private-use sentinel: it survives `parseBlocks` line splitting (it is
	 * not whitespace, so block detection still sees the real line shape) and
	 * carries where a marker stood. */
	const PILL = '\u0001';
	const INLINE = /\u0001([^\u0001]*)\u0001/g;

	/** Recombine the run/marker split into ONE string for the block pass.
	 * Model text cannot carry the sentinel: it is a control character and
	 * stripped, so a literal U+0001 in an answer can never forge a marker. */
	const raw = $derived(
		parts
			.map((p) =>
				p.kind === 'pill'
					? `${PILL}${p.n}${PILL}`
					: p.text.replace(/\u0001/g, '')
			)
			.join('')
	);
	const blocks = $derived(parseBlocks(raw));

	type Inline = { kind: 'html'; text: string } | { kind: 'pill'; n: number };

	/** Split one block's inline text into sanitized HTML runs and markers.
	 * A marker that follows a space loses that space: the model writes
	 * `word [1]`, and the space is a line-break opportunity that orphans the
	 * mark onto the next line ("…not revoked ⏎ ¹."). */
	function inlineOf(text: string): Inline[] {
		const out: Inline[] = [];
		let last = 0;
		for (const m of text.matchAll(INLINE)) {
			const at = m.index ?? 0;
			if (at > last) out.push({ kind: 'html', text: text.slice(last, at) });
			const prev = out[out.length - 1];
			if (prev?.kind === 'html') prev.text = prev.text.replace(/ $/, '');
			out.push({ kind: 'pill', n: Number(m[1]) });
			last = at + m[0].length;
		}
		if (last < text.length) out.push({ kind: 'html', text: text.slice(last) });
		return out;
	}

	/** Citation numbers carried by one block, in reading order. */
	function citesIn(text: string): number[] {
		const nums: number[] = [];
		for (const m of text.matchAll(INLINE)) {
			const n = Number(m[1]);
			if (!nums.includes(n)) nums.push(n);
		}
		return nums;
	}

	/** Block-level claim pairing (#30): the block that carries a mark tints
	 * when that mark is spotlit. */
	function blockStyle(marks: number[]): string {
		if (marks.length === 0) return '';
		const c = byN.get(marks[0])?.colorIndex ?? 0;
		return `--cite: var(--cite-${c}); --cite-tint: var(--cite-${c}-tint);`;
	}
</script>

{#snippet inlineFlow(text: string)}
	{#each inlineOf(text) as seg, index (index)}
		{#if seg.kind === 'html'}
			{@html inlineHtml(seg.text)}
		{:else if seg.kind === 'pill'}
			{@const citation = byN.get(seg.n)}
			{#if citation}
				<CitationPill
					{citation}
					open={openN === seg.n}
					{onToggle}
					controls={onToggle === undefined ? undefined : `${idPrefix}-src-${seg.n}`}
				/>
			{/if}
		{/if}
	{/each}
{/snippet}

<div class="answer">
	{#each blocks as block, blockIndex (blockIndex)}
		{#if block.kind === 'paragraph'}
			{@const marks = citesIn(block.text)}
			<p class="md-p" class:claim={marks.length > 0} class:spotlit={spotlight.lit(marks)} style={blockStyle(marks)}>
				{@render inlineFlow(block.text)}
			</p>
		{:else if block.kind === 'heading'}
			<!-- Model headings render as headings (#185); level is semantics, the
			 * display size is the column's single kicker size. -->
			{#if block.level <= 2}
				<h2 class="md-h">{@render inlineFlow(block.text)}</h2>
			{:else}
				<h3 class="md-h">{@render inlineFlow(block.text)}</h3>
			{/if}
		{:else if block.kind === 'bullets'}
			<ul class="md-ul">
				{#each block.items as item, itemIndex (itemIndex)}
					{@const marks = citesIn(item)}
					<li class:claim={marks.length > 0} class:spotlit={spotlight.lit(marks)} style={blockStyle(marks)}>
						{@render inlineFlow(item)}
					</li>
				{/each}
			</ul>
		{:else if block.kind === 'numbered'}
			<ol class="md-ol">
				{#each block.items as item, itemIndex (itemIndex)}
					{@const marks = citesIn(item)}
					<li class:claim={marks.length > 0} class:spotlit={spotlight.lit(marks)} style={blockStyle(marks)}>
						{@render inlineFlow(item)}
					</li>
				{/each}
			</ol>
		{:else if block.kind === 'table'}
			<div class="md-table-wrap">
				<table class="md-table">
					<thead>
						<tr>
							{#each block.header as cell, column (column)}
								<th style="text-align: {block.align[column] ?? 'left'}">{@render inlineFlow(cell)}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each block.rows as row, rowIndex (rowIndex)}
							<tr>
								{#each row as cell, column (column)}
									<td style="text-align: {block.align[column] ?? 'left'}">{@render inlineFlow(cell)}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<pre class="md-pre"><code class={block.lang === '' ? undefined : `lang-${block.lang}`}
					>{@html escapeHtml(block.text)}</code
				></pre>
		{/if}
	{/each}
</div>

<style>
	.answer {
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	/* Claim span: the permanent dotted rule is gone (#185). A citation mark
	 * says where the support is; the tint answers "which sentence?" only
	 * while the mark or its register row is under the cursor (#30 pairing). */
	.claim {
		transition: background-color 120ms ease-out;
	}
	.claim.spotlit {
		background: var(--cite-tint);
	}
	.md-p {
		margin: 0.3em 0;
	}
	/* Markers are restored (#185): Tailwind's preflight strips list-style, so
	 * the shipped renderer drew bullets as indented paragraphs. */
	.md-ul,
	.md-ol {
		margin: 0.15em 0;
		padding-left: 1.15em;
	}
	.md-ul {
		list-style: disc;
	}
	.md-ol {
		list-style: decimal;
	}
	.md-ul li::marker {
		color: var(--ink-3);
	}
	.md-ol li::marker {
		color: var(--ink-3);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
	}
	/* A model heading is a section label, not a display type: mono caps keep
	 * the column's single reading size and the writing rule (§9). */
	.md-h {
		margin: 0.7em 0 0.2em;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--ink-2);
	}
	.md-h:first-child {
		margin-top: 0;
	}
	.md-pre {
		margin: 0.35em 0;
		padding: 0.5em 0.75em;
		border-radius: var(--radius-chip, 6px);
		background: var(--inset);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 12px;
		overflow-x: auto;
		white-space: pre-wrap;
	}
	.md-table-wrap {
		margin: 0.4em 0;
		overflow-x: auto;
	}
	.md-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12.5px;
		line-height: 1.4;
	}
	/* Hairline table (#185): vertical rules at a 288px measure turn a three
	 * column table into a grid of cells to decode; the header rule and row
	 * separators carry the structure instead. */
	.md-table th,
	.md-table td {
		border: 0;
		border-bottom: 1px solid var(--line);
		padding: 0.32em 0.6em 0.32em 0;
		vertical-align: top;
	}
	.md-table th {
		background: none;
		border-bottom: 1px solid var(--line-strong);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 9.5px;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
	.md-table tr:last-child td {
		border-bottom: 0;
	}
</style>
