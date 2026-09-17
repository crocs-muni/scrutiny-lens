<script lang="ts">
	/* Settled-answer footer (chat-output rework T4, 2026-09-17): action row
	 * [copy | N-sources stack toggle] + expandable sources panel — the
	 * source pattern ported from beautiful-ui's StreamingText (vendored
	 * LoadingState rides the same lineage; MIT attribution in its header).
	 *
	 * Rows: [n] badge in the citation's paired color · title · publisher
	 * cell (kind-0 avatar/name, identicon fallback — PublisherChip owns
	 * the identity seam) · open dossier. Mono id fallback when the cited
	 * event left the in-memory grounding set (a transcript restored from
	 * IDB carries citations, not events) — the row degrades honestly,
	 * never crash, never guess. */

	import { IconCheck, IconChevronDown, IconChevronRight, IconCopy } from '@tabler/icons-svelte';
	import { chat } from '$lib/chat.svelte';
	import PublisherChip from '../ui/PublisherChip.svelte';
	import { spotlight } from './spotlight.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		/** Settled message content — the copy button's payload. */
		content: string;
		citations: PersistedChatCitation[];
		onOpenDossier: (eventId: string) => void;
	}

	let { content, citations, onOpenDossier }: Props = $props();

	let open = $state(false);
	let copied = $state(false);

	/* Conversation numbering dedupe (two claims, one source) — same rule
	 * SourceChips's chips carried. */
	const unique = $derived.by(() => {
		const seen = new Set<number>();
		return citations.filter((c) => !seen.has(c.n) && seen.add(c.n));
	});

	const pubkeyOf = (eventId: string): string | undefined =>
		chat.grounding.find((e) => e.id === eventId)?.pubkey;

	async function copyAnswer(): Promise<void> {
		await navigator.clipboard.writeText(content);
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
</script>

<div class="mt-2">
	<!-- action row -->
	<div class="flex items-center gap-0.5">
		<button
			type="button"
			aria-label="Copy answer"
			class="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
			onclick={copyAnswer}
		>
			{#if copied}
				<IconCheck size={14} stroke-width={1.8} />
			{:else}
				<IconCopy size={14} stroke-width={1.8} />
			{/if}
		</button>
		{#if unique.length > 0}
			<button
				type="button"
				aria-expanded={open}
				class="ml-1.5 flex items-center gap-1.5 rounded-chip px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
				onclick={() => (open = !open)}
			>
				<span class="flex -space-x-1">
					{#each unique.slice(0, 4) as citation (citation.n)}
						<span
							class="flex size-4 items-center justify-center rounded-full bg-surface font-mono text-[8.5px] font-semibold shadow-[0_0_0_1.5px_var(--canvas)]"
							style="color: var(--cite-{citation.colorIndex}); background: var(--cite-{citation.colorIndex}-tint);"
						>{citation.n}</span>
					{/each}
				</span>
				<span class="text-[12px] text-ink-2">{unique.length} source{unique.length === 1 ? '' : 's'}</span>
				<IconChevronDown
					size={12}
					stroke-width={1.8}
					class="text-ink-3 transition-transform duration-200 {open ? 'rotate-180' : ''}"
				/>
			</button>
		{/if}
	</div>

	<!-- expandable sources panel -->
	<div
		class="grid transition-[grid-template-rows,opacity] duration-300"
		style:grid-template-rows={open ? '1fr' : '0fr'}
		style:opacity={open ? 1 : 0}
		style:transition-timing-function="cubic-bezier(0.23, 1, 0.32, 1)"
	>
		<div class="overflow-hidden">
			<div class="mt-1.5 flex flex-col rounded-card bg-inset p-1 shadow-hairline">
				{#each unique as citation (citation.n)}
					{@const pubkey = pubkeyOf(citation.eventId)}
					<button
						type="button"
						class="flex items-center gap-2 rounded-chip px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink source-row"
						class:spotlit={spotlight.lit([citation.n])}
						style="--cite: var(--cite-{citation.colorIndex}); --cite-tint: var(--cite-{citation.colorIndex}-tint);"
						onmouseenter={() => spotlight.hover([citation.n])}
						onmouseleave={() => spotlight.hover(null)}
						onclick={() => onOpenDossier(citation.eventId)}
					>
						<span class="row-n">{citation.n}</span>
						{#if pubkey !== undefined}
							<PublisherChip {pubkey} />
						{:else}
							<!-- grounding event left memory: mono machine id, the honest cell -->
							<span class="font-mono text-[10.5px] text-ink-3">…{citation.eventId.slice(-8)}</span>
						{/if}
						<span class="min-w-0 flex-1 truncate text-left">{citation.nodeTitle ?? 'Cited event'}</span>
						<span class="ml-auto flex items-center gap-0.5 text-[11px] text-ink-3">
							open dossier <IconChevronRight size={11} stroke-width={2} />
						</span>
					</button>
				{/each}
			</div>
		</div>
	</div>
</div>

<style>
	/* Row spotlights are dynamic --cite colors (spotlight.svelte coupling):
	 * the class is composed at runtime, so the rule must be global-safe. */
	.row-n {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--cite);
	}
	.source-row.spotlit {
		background: var(--cite-tint);
	}
</style>
