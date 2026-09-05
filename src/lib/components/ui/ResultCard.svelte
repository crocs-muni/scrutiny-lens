<script lang="ts">
	/* RESULT CARD — the P3 anatomy (issue #38, spec §9 + §2 rule 5).
	 *
	 * Three variants, one file so they stay in sync:
	 *   interpreted     — solid card: AI title + snippet (sans; AI prose is
	 *                     ALWAYS sans per the writing rule), mono identifier
	 *                     chips, deterministic icon+word counts, publisher chip.
	 *   not interpreted — dashed border (BIBLE legend), the event's own tags +
	 *                     first chars, "not interpreted" badge. ≡ no-key
	 *                     fallback ≡ AI-down/timeout degradation (spec §2 rule 5).
	 *   retracted       — either variant + warning status pill from the
	 *                     protocol (kind-5), never AI — variant-independent.
	 *
	 * The whole card is one click target (hover raises the ring): #29's
	 * drawer is the destination; the prop exists so the wiring never
	 * repaints the card. Values here are machine-made except title/snippet. */

	import type { ProductCard } from '$lib/pipeline/cards';
	import type { SkeletonCard } from '$lib/pipeline';
	import PublisherChip from './PublisherChip.svelte';
	import { IconLink, IconPencil } from '@tabler/icons-svelte';

	interface Props {
		/** Skeleton during fetch (rule 5), ProductCard once assembled. */
		card: ProductCard | SkeletonCard;
		onOpen?(): void;
	}

	let { card, onOpen }: Props = $props();

	const product: ProductCard | null = $derived('identifiers' in card ? card : null);
	const dashed = $derived(product === null || !product.interpreted);

	// Rule-5 fallback title/body — machine vocabulary only (mono).
	const fallbackTitle = $derived(
		product !== null
			? product.title
			: (card as SkeletonCard).typeTag ??
					(card as SkeletonCard).itags[0] ??
					(card as SkeletonCard).contentStart.slice(0, 60)
	);
	const fallbackRaw = $derived(
		product !== null
			? [
					`t: ${product.typeTag}`,
					...product.identifiers.slice(0, 3).map((t) => `i: ${t}`),
					`"${product.contentStart}"`
				].join(' · ')
			: [
					(card as SkeletonCard).typeTag ? `t: ${(card as SkeletonCard).typeTag}` : null,
					...(card as SkeletonCard).itags.slice(0, 3).map((t) => `i: ${t}`),
					`"${(card as SkeletonCard).contentStart}"`
				]
					.filter((s): s is string => s !== null)
					.join(' · ')
	);

	const shownIdentifiers = $derived(product === null ? [] : product.identifiers.slice(0, 4));
	const extraIdentifiers = $derived(
		product === null ? 0 : product.identifiers.length - shownIdentifiers.length
	);

	function open(): void {
		onOpen?.();
	}

	function keyOpen(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onOpen?.();
		}
	}
</script>

<!-- The card IS one click target (spec §9); role/tabindex move
	together by construction (both only when onOpen), so the two a11y
	rules below are false positives here. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
	role={onOpen !== undefined ? 'button' : undefined}
	tabindex={onOpen !== undefined ? 0 : undefined}
	onclick={open}
	onkeydown={keyOpen}
	class="rounded-card border-[1.5px] bg-surface px-4 py-3 shadow-card transition-shadow duration-150
		{dashed ? 'border-dashed border-line-strong' : 'border-line'}
		{onOpen !== undefined ? 'cursor-pointer hover:shadow-raised' : ''}
		[content-visibility:auto] [contain-intrinsic-size:auto_120px]"
>
	{#if dashed}
		<!-- fetch-stage skeleton ≡ settled rule-5 fallback ≡ AI down/timed-out
			chunk (spec §2 rule 5): the event's own tags + first chars, badge on. -->
		<div class="flex items-center gap-2">
			<h3 class="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-ink">
				{fallbackTitle}
			</h3>
			{#if product?.retracted}
				<span
					class="shrink-0 rounded-full border border-orange bg-orange-tint px-2 py-0.5 font-mono text-[10.5px] text-orange"
				>
					retracted
				</span>
			{/if}
			<span
				class="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-ink-3"
			>
				not interpreted
			</span>
		</div>
		<p class="mt-1.5 line-clamp-3 font-mono text-[11px] leading-relaxed break-all text-ink-2">
			{fallbackRaw}
		</p>
		{#if product !== null}
			<!-- publisher identity is deterministic (kind-0 of the event's own
				author) — shown on settled dashed cards too; skeletons have no
				pubkey, so they stay bare (owner ruling 2026-09-04). -->
			{@render cardFoot(product)}
		{/if}
		{:else if product !== null}
		<!-- interpreted (P3) -->
		<div class="flex items-start gap-2">
			<h3 class="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold text-ink">
				{product.title}
			</h3>
			{#if product.retracted}
				<!-- spec §2 rule 2: status is protocol-computed, never AI -->
				<span
					class="shrink-0 rounded-full border border-orange bg-orange-tint px-2 py-0.5 font-mono text-[10.5px] text-orange"
				>
					retracted
				</span>
			{/if}
		</div>
		{#if product.snippet !== undefined}
			<p class="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">{product.snippet}</p>
		{/if}
		{#if shownIdentifiers.length > 0}
			<div class="mt-2 flex flex-wrap items-center gap-1">
				{#each shownIdentifiers as id (id)}
					<span
						class="rounded-chip border border-line bg-inset px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2"
					>
						{id}
					</span>
				{/each}
				{#if extraIdentifiers > 0}
					<span class="font-mono text-[10.5px] text-ink-3">+{extraIdentifiers}</span>
				{/if}
			</div>
		{/if}
	{@render cardFoot(product)}
	{/if}
</article>

{#snippet cardFoot(c: ProductCard)}
	<!-- footer row shared by dashed+interpreted: publisher kind-0 chip +
		deterministic counts (spec §2 rule 2; icons per §9 anatomy) -->
	<div class="mt-2.5 flex items-center gap-3">
		<PublisherChip pubkey={c.pubkey} />
		<span class="flex-1"></span>
		<span class="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
			<IconLink size={10} stroke={1.5} aria-hidden="true" />
			{c.boundMetadata} binding{c.boundMetadata === 1 ? '' : 's'}
			{#if c.updates > 0}
				<IconPencil size={10} stroke={1.5} aria-hidden="true" />
				{c.updates} update{c.updates === 1 ? '' : 's'}
			{/if}
		</span>
	</div>
{/snippet}
