<script lang="ts">
	/* Settled-answer source register (issue #184, superseding the T4 footer).
	 * The register is ALWAYS visible: the old "N sources ⌄" toggle hid every
	 * provenance behind a click, and the hover-card it duplicated could not be
	 * operated at all (WCAG 2.2 SC 1.4.13, F95). One row per source; clicking
	 * a row toggles its verified quote, and only the explicit dossier button
	 * navigates — a row click never leaves the answer.
	 *
	 * Rows are computed, never prose (#185): status is the protocol's kind-5
	 * reading (spec §2 rule 2) and the quote is the verified span or the
	 * model's verbatim quote (ADR 0003). A record missing from the session's
	 * grounding set carries `unknown` and renders no status chip — never a
	 * guessed one. */

	import { IconCheck, IconChevronRight, IconCopy } from '@tabler/icons-svelte';
	import { spotlight } from './spotlight.svelte';
	import type { SourceRow } from '$lib/chat/turnMeta';

	interface Props {
		/** Settled content, the copy button's payload. */
		content: string;
		/** Distinct sources in registry order (turnMeta owns the dedupe). */
		sources: SourceRow[];
		/** The turn owns which row is open — one at a time across the answer. */
		openN: number | null;
		onToggle: (n: number) => void;
		onOpenDossier: (eventId: string) => void;
	}

	let { content, sources, openN, onToggle, onOpenDossier }: Props = $props();

	let copied = $state(false);

	async function copyAnswer(): Promise<void> {
		await navigator.clipboard.writeText(content);
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
</script>

<div class="mt-2">
	<!-- Every source is on screen from the first paint: provenance is not a
	     disclosure widget (spec §2 — trust is shown, not hovered for). -->
	<div class="flex flex-col rounded-card bg-inset p-1 shadow-hairline">
		{#each sources as source (source.n)}
			<div
				class="source flex flex-col rounded-chip"
				class:spotlit={spotlight.lit([source.n])}
				style="--cite: var(--cite-{source.colorIndex}); --cite-tint: var(--cite-{source.colorIndex}-tint);"
			>
				<button
					type="button"
					class="flex w-full items-center gap-2 rounded-chip px-1.5 py-1 text-left text-[12px] text-ink-2 transition-colors duration-150 hover:text-ink"
					aria-expanded={openN === source.n}
					onmouseenter={() => spotlight.hover([source.n])}
					onmouseleave={() => spotlight.hover(null)}
					onclick={() => onToggle(source.n)}
				>
					<span class="row-n">{source.n}</span>
					<span class="min-w-0 flex-1 truncate">{source.title}</span>
					{#if source.status === 'retracted'}
						<!-- Protocol status, never presentational (spec §2 rule 2):
						     the same word the dossier carries. -->
						<span
							class="shrink-0 rounded-[4px] bg-orange-tint px-1 py-px font-mono text-[8.5px] font-medium tracking-wide text-orange uppercase"
						>
							retracted
						</span>
					{/if}
					<IconChevronRight
						size={11}
						stroke-width={2}
						class="shrink-0 text-ink-3 transition-transform duration-150 {openN === source.n
							? 'rotate-90'
							: ''}"
					/>
				</button>
				{#if openN === source.n}
					<blockquote class="row-quote">{source.quote}</blockquote>
					<button type="button" class="row-dossier" onclick={() => onOpenDossier(source.eventId)}>
						open dossier ↗
					</button>
				{/if}
			</div>
		{/each}
	</div>

	<!-- One compact action line: copy + count, nothing else. -->
	<div class="mt-1.5 flex items-center gap-1 text-[11px] text-ink-3">
		<button
			type="button"
			class="flex items-center gap-1 rounded-chip px-1 py-0.5 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
			onclick={copyAnswer}
		>
			{#if copied}
				<IconCheck size={12} stroke-width={1.8} />
			{:else}
				<IconCopy size={12} stroke-width={1.8} />
			{/if}
			<span>copy</span>
		</button>
		<span aria-hidden="true">·</span>
		<span>{sources.length} source{sources.length === 1 ? '' : 's'}</span>
	</div>
</div>

<style>
	/* The row's hue is a CSS variable set inline (citation pairing, ruling 4);
	 * every hue-dependent rule reads it, so no dynamic class names are needed. */
	.row-n {
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--cite);
	}
	.source.spotlit {
		background: var(--cite-tint);
	}
	/* Verified quote = machine-checked text: mono by the writing rule (spec §9),
	 * and the row's hue marks which source it belongs to. */
	.row-quote {
		margin: 2px 4px 4px 6px;
		padding-left: 8px;
		border-left: 2px solid var(--cite);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 10.5px;
		line-height: 1.6;
		color: var(--ink-2);
	}
	.row-dossier {
		align-self: flex-start;
		margin: 0 4px 6px 6px;
		padding: 0;
		background: none;
		border: none;
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 10.5px;
		color: var(--cite);
		cursor: pointer;
	}
	.row-dossier:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
