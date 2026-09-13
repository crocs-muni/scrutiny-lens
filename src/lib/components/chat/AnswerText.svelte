<script lang="ts">
	/* Settled chat answer renderer (issue #30, ruling 3): prose runs through
	 * marked-inline + DOMPurify on EVERY {@html} path (hard rule); claim
	 * spans wear the dotted paired-color underline; verified markers become
	 * citation pills. The layout (which run carries which marks) is computed
	 * by $lib/chat/answer — this file renders, it never re-decides. */

	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { layoutAnswer } from '$lib/chat/answer';
	import { spotlight } from './spotlight.svelte';
	import CitationPill from './CitationPill.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		content: string;
		citations: PersistedChatCitation[];
		onOpenDossier: (eventId: string) => void;
	}

	let { content, citations, onOpenDossier }: Props = $props();

	const parts = $derived(layoutAnswer(content, citations));
	const byN = $derived(new Map(citations.map((c) => [c.n, c])));
	/* Card ownership: the first pill of each citation number owns the
	 * hover-card; later markers of the same [N] still glow (spotlight is
	 * number-keyed) but never double the card. */
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

	// Inline markdown only — citations split the text, so a block parser
	// would invent structure across the seams. Sanitized, always.
	function inline(text: string): string {
		return DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string);
	}
</script>

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
		{:else if part.marks.length === 0}
			{@html inline(part.text)}
		{:else}
			{@const first = byN.get(part.marks[0])}
			<span
				class="claim"
				class:spotlit={spotlight.lit(part.marks)}
				style="--cite: var(--cite-{first?.colorIndex ?? 0}); --cite-tint: var(--cite-{first?.colorIndex ?? 0}-tint);"
				onmouseenter={() => spotlight.hover(part.marks)}
				onmouseleave={() => spotlight.hover(null)}
				role="note"
				aria-label="Cited claim: {part.marks.map((n) => `[${n}]`).join(', ')}"
				>{@html inline(part.text)}</span
			>
		{/if}
	{/each}
</span>

<style>
	.claim {
		border-bottom: 1.5px dotted var(--cite);
		transition: background-color 120ms ease-out;
		cursor: default;
	}
	.claim.spotlit {
		background: var(--cite-tint);
	}
</style>
