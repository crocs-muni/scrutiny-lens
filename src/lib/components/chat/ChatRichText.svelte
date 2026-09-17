<script lang="ts">
	/* The chat's ONE rich-text renderer (chat-output rework T2, 2026-09-17).
	 * Live stream and settled messages both land here: text runs blockify
	 * through $lib/chat/markdown (paragraphs/ul/ol/fences, inline markdown
	 * inside), verified markers become CitationPill instances, and complete-
	 * but-unresolved stream markers show the neutral pending shimmer — whose
	 * class lives HERE, not in the column shell.
	 *
	 * The layout decisions (which run carries which claim marks; marker
	 * positions) arrive pre-computed from layoutAnswer / parseChatStream —
	 * this component renders, it never re-decides. */

	import { inlineHtml, parseBlocks, escapeHtml } from '$lib/chat/markdown';
	import { spotlight } from './spotlight.svelte';
	import CitationPill from './CitationPill.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	/** One render unit: flat markdown, a verified pill, or a live pending shimmer. */
	export type RichPart =
		| { kind: 'text'; text: string; marks: number[] }
		| { kind: 'pill'; n: number; marks: number[] }
		| { kind: 'pending'; n: number | null };

	interface Props {
		parts: RichPart[];
		/** Verified citations (settled path). Empty during streaming. */
		citations?: PersistedChatCitation[];
		onOpenDossier?: (eventId: string) => void;
	}

	let { parts, citations = [], onOpenDossier = () => {} }: Props = $props();

	const byN = $derived(new Map(citations.map((c) => [c.n, c])));
	/* Card ownership rule (issue #30): the first pill of each citation number
	 * owns the hover-card; later markers of the same [N] still glow but never
	 * double the card. */
	const owners = $derived.by(() => {
		const seen = new Set<number>();
		const out = new Set<string>();
		for (const p of parts) {
			if (p.kind === 'pill' && !seen.has(p.n)) {
				seen.add(p.n);
				out.add(`${p.n}:${parts.indexOf(p)}`);
			}
		}
		return out;
	});
</script>

{#snippet textRun(text: string, marks: number[])}
	{@const blocks = parseBlocks(text)}
	{@const claim = marks.length > 0}
	{@const first = claim ? byN.get(marks[0]) : undefined}
	{#if blocks.length === 1 && blocks[0].kind === 'paragraph'}
		<span
			class:claim
			class:spotlit={claim && spotlight.lit(marks)}
			style="--cite: var(--cite-{first?.colorIndex ?? 0}); --cite-tint: var(--cite-{first?.colorIndex ?? 0}-tint);"
		>{@html inlineHtml(blocks[0].text)}</span>
	{:else}
		<div
			class="md"
			class:claim
			class:spotlit={claim && spotlight.lit(marks)}
			style="--cite: var(--cite-{first?.colorIndex ?? 0}); --cite-tint: var(--cite-{first?.colorIndex ?? 0}-tint);"
		>
			{#each blocks as block (block.kind)}
				{#if block.kind === 'paragraph'}
					<p class="md-p">{@html inlineHtml(block.text)}</p>
				{:else if block.kind === 'bullets'}
					<ul class="md-ul">{#each block.items as item (item)}<li>{@html inlineHtml(item)}</li>{/each}</ul>
				{:else if block.kind === 'numbered'}
					<ol class="md-ol">{#each block.items as item (item)}<li>{@html inlineHtml(item)}</li>{/each}</ol>
				{:else}
					<pre class="md-pre"><code class={block.lang === '' ? undefined : `lang-${block.lang}`}
							>{@html escapeHtml(block.text)}</code
						></pre>
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<span class="answer">
	{#each parts as part, i (i)}
		{#if part.kind === 'pill'}
			{@const citation = byN.get(part.n)}
			{#if citation}
				<CitationPill
					{citation}
					ownsCard={owners.has(`${part.n}:${i}`)}
					{onOpenDossier}
				/>
			{/if}
		{:else if part.kind === 'pending'}
			<span class="pending-pill" aria-label="Verifying citation {part.n ?? ''}…">{part.n ?? ''}</span>
		{:else}
			{@render textRun(part.text, part.marks)}
		{/if}
	{/each}
</span>

<style>
	.answer {
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--ink);
	}
	/* Claim span: dotted paired-color underline (issue #30 registry pairing).
	 * Block runs propagate the decoration onto paragraph/list-item surfaces —
	 * a claim that spawns a list no longer loses its underline line. */
	.claim {
		border-bottom: 1.5px dotted var(--cite);
		transition: background-color 120ms ease-out;
		cursor: default;
	}
	.claim.spotlit {
		background: var(--cite-tint);
	}
	.md {
		margin: 0.25em 0;
	}
	.md-ul,
	.md-ol {
		margin: 0.15em 0;
		padding-left: 1.15em;
	}
	.md-ul li,
	.md-ol li {
		border-bottom: inherit;
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
	/* The pending shimmer (pinned-at-stream citation): neutral on purpose —
	 * nothing is verified yet, so nothing claims a trust color. */
	.pending-pill {
		display: inline-block;
		min-width: 1.15em;
		height: 1.05em;
		padding: 0 0.3em;
		border-radius: 0.5em;
		background: var(--inset);
		color: var(--ink-3);
		font-size: 0.72em;
		line-height: 1.05em;
		text-align: center;
		vertical-align: 0.12em;
		overflow: hidden;
		animation: chat-pending-pulse 1.1s ease-in-out infinite;
	}
	@keyframes chat-pending-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
