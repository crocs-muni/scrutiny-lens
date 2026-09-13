<script lang="ts">
	/* Source chips row under an answer (G1 footer anatomy — "Perplexity
	 * footer, shared citation id"): one chip per cited event, numbered in
	 * conversation order. Hover lights the claim span; click jumps straight
	 * to the dossier — the chip is a compact affordance of the same
	 * coordination the hover-card's "open dossier →" carries. */

	import { spotlight } from './spotlight.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		citations: PersistedChatCitation[];
		onOpenDossier: (eventId: string) => void;
	}

	let { citations, onOpenDossier }: Props = $props();

	/* Conversation numbering can repeat an event inside one answer (two
	 * claims, one source) — chips dedupe by number. */
	const unique = $derived.by(() => {
		const seen = new Set<number>();
		return citations.filter((c) => !seen.has(c.n) && seen.add(c.n));
	});
</script>

{#if unique.length > 0}
	<div class="chips" aria-label="Sources">
		{#each unique as citation (citation.n)}
			<button
				class="chip"
				class:spotlit={spotlight.lit([citation.n])}
				style="--cite: var(--cite-{citation.colorIndex}); --cite-tint: var(--cite-{citation.colorIndex}-tint);"
				onmouseenter={() => spotlight.hover([citation.n])}
				onmouseleave={() => spotlight.hover(null)}
				onclick={() => onOpenDossier(citation.eventId)}
				aria-label="Source {citation.n}: {citation.nodeTitle ?? 'open dossier'}"
			>
				<span class="chip-n">{citation.n}</span>
				<span class="chip-title">{citation.nodeTitle ?? 'Source'}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.chips {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 5px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 9999px;
		padding: 4px 10px;
		font-size: 11.5px;
		color: var(--ink-2);
		transition: background-color 120ms ease-out;
		min-width: 0;
	}
	.chip:hover,
	.chip.spotlit {
		background: var(--cite-tint);
	}
	.chip-n {
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--cite);
	}
	.chip-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 180px;
	}
</style>
