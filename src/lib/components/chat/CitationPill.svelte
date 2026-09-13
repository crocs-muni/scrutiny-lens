<script lang="ts">
	/* Citation pill + hover-card (issue #30, G1 "AI-Elements hover-card"
	 * anatomy). Open model: hovering the pill OR the claim span (via the
	 * spotlight) opens the card zero-delay; clicking the pill PINS it —
	 * esc/outside-close unsettles the pin, hover transiently previews.
	 * Portal-mounted: the chat column itself clips overflow.
	 *
	 * The quote is the VERIFIED span (computed, never model prose) — partial
	 * matches fall back to their matched run, which is verbatim by
	 * construction (spec §2 rule 3; ADR 0003). */

	import { Popover } from 'bits-ui';
	import { IconChevronRight, IconCheck, IconCopy } from '@tabler/icons-svelte';
	import { spotlight } from './spotlight.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		citation: PersistedChatCitation;
		/** Only the first pill of a citation number owns the card — a second
		 * marker of the same [N] still glows but never doubles the card. */
		ownsCard: boolean;
		onOpenDossier: (eventId: string) => void;
	}

	let { citation, ownsCard, onOpenDossier }: Props = $props();

	let pinned = $state(false);
	let pillHover = $state(false);
	// Transient hover-open dies with the cursor; the pin survives both flee paths.
	let open = $derived(ownsCard && (pinned || pillHover || spotlight.has(citation.n)));
	let copied = $state(false);
	/** Verified display quote — the matched span (verbatim by construction),
	 * else the model's verbatim quote. */
	let quote = $derived(citation.span ?? citation.quote);

	async function copyQuote(): Promise<void> {
		await navigator.clipboard.writeText(quote);
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
</script>

<Popover.Root
	bind:open
	onOpenChange={(v) => {
		// Only esc/outside-close reaches false here (hover-open never binds) —
		// treat it as unpin.
		if (!v) pinned = false;
	}}
>
	<Popover.Trigger
		class="cite-pill {spotlight.lit([citation.n]) ? 'spotlit' : ''}"
		style="--cite: var(--cite-{citation.colorIndex}); --cite-tint: var(--cite-{citation.colorIndex}-tint);"
		aria-label="Citation {citation.n}: {citation.nodeTitle ?? 'source event'}"
		onmouseenter={() => {
			pillHover = true;
			spotlight.hover([citation.n]);
		}}
		onmouseleave={() => {
			pillHover = false;
			if (spotlight.active.length === 1 && spotlight.has(citation.n)) spotlight.hover(null);
		}}
		onclick={() => (pinned = !pinned)}
	>
		{citation.n}
	</Popover.Trigger>
	{#if ownsCard}
		<Popover.Portal>
			<Popover.Content
				side="bottom"
				align="start"
				sideOffset={8}
				collisionPadding={12}
				class="cite-card"
				style="--cite: var(--cite-{citation.colorIndex}); --cite-tint: var(--cite-{citation.colorIndex}-tint);"
			>
				<div class="cite-card-head">
					<span class="cite-card-num">{citation.n}</span>
					<span class="cite-card-title">{citation.nodeTitle ?? 'Source event'}</span>
				</div>
				<blockquote class="cite-quote">“{quote}”</blockquote>
				<div class="cite-card-actions">
					<button
						class="cite-action cite-action--primary"
						onclick={() => onOpenDossier(citation.eventId)}
					>
						open dossier <IconChevronRight size={12} stroke-width={2} />
					</button>
					<button class="cite-action" onclick={copyQuote}>
						{#if copied}<IconCheck size={12} stroke-width={2} /> copied{:else}<IconCopy size={12} stroke-width={1.8} /> copy quote{/if}
					</button>
				</div>
			</Popover.Content>
		</Popover.Portal>
	{/if}
</Popover.Root>

<style>
	/* Global like the card: the class rides a dynamic string on a bits-ui
	 * component, which scoped-CSS usage analysis can't see. */
	:global(.cite-pill) {
		display: inline-block;
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 11px;
		line-height: 1;
		padding: 2px 6px;
		border-radius: 5px;
		vertical-align: 1px;
		background: var(--cite-tint);
		color: var(--cite);
		border: none;
		transition: box-shadow 120ms ease-out;
	}
	:global(.cite-pill:hover),
	:global(.cite-pill.spotlit) {
		box-shadow: inset 0 -2px 0 0 var(--cite);
	}

	/* The card portals to <body> (the chat column clips overflow); every
	 * card-side class is global — scoped hashes never reach portal nodes. */
	:global(.cite-card) {
		z-index: 50;
		width: 270px;
		background: var(--surface);
		border-radius: 12px;
		box-shadow: var(--shadow-overlay);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	:global(.cite-card-head) {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	:global(.cite-card-num) {
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		padding: 2px 6px;
		border-radius: 5px;
		background: var(--cite-tint);
		color: var(--cite);
		border: 1px solid color-mix(in oklch, var(--cite) 35%, transparent);
	}
	:global(.cite-card-title) {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Verified quote = machine-checked text: mono by the writing rule (spec §9). */
	:global(.cite-quote) {
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 11.5px;
		color: var(--ink-2);
		line-height: 1.6;
		padding-left: 8px;
		border-left: 2px solid var(--line);
		margin: 0;
	}
	:global(.cite-card-actions) {
		display: flex;
		gap: 12px;
		align-items: center;
	}
	:global(.cite-action) {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11.5px;
		color: var(--ink-2);
		border: none;
		background: none;
		padding: 0;
	}
	:global(.cite-action--primary) {
		color: var(--cite);
		font-weight: 550;
	}
</style>
