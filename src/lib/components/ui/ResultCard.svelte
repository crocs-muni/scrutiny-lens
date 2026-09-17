<script lang="ts">
	/* RESULT CARD — P3 anatomy per BIBLE J2 (issue #38, spec §9 + §2 rule 5).
	 *
	 * Variants:
	 *   interpreted     — title (sans 14.5/600) + snippet (sans 13.5, lh 1.55);
	 *                     mono id chips; hairline-split footer (publisher chip
	 *                     + event-age clock + icon counts). No action buttons
	 *                     on faces (spec §9): sharing lives in the drawer's
	 *                     SharePopover, never on the card surface.
	 *   not interpreted — dashed border, event's own tags + first chars,
	 *                     "not interpreted" badge; same footer (publisher +
	 *                     metadata/files/updates counts are deterministic,
	 *                     never AI).
	 *   interpreting…   — SAME dashed face, no badge: the whole card carries
	 *                     the shared neutral sweep (.fill-sweep, issue #82's
	 *                     grammar) sourced from investigation.pending — a card
	 *                     8s into a 14s call must not read identically to one
	 *                     that will never be interpreted (spec §2). The sweep
	 *                     is chrome ON TOP of the true rule-5 face, never veils it.
	 *   fill failed     — claimed by a lane but settled uninterpreted this
	 *                     pass: persistent amber-tint background (the shared
	 *                     "degraded" vocabulary — trace warn cells,
	 *                     NoticeBanner). Amber is a COLOR state, so the
	 *                     reduced-motion floor costs honesty nothing.
	 *   retracted       — either variant + red warning pill (protocol kind-5,
	 *                     never presentational, spec §2 rule 2); retracted
	 *                     interpreted cards name their provenance ("as relays
	 *                     returned").
	 *
	 * Settle (#82): when `interpreted` flips true while the card is mounted,
	 * the two faces crossfade as ONE unit (~260ms) and the border flips
	 * dashed→solid at the midpoint (settle-border keyframe). Cache-hit cards
	 * arrive interpreted on FIRST paint and bloom never fires — calm is the
	 * rule: motion marks change after first stable paint, never provenance. */

	import type { ProductCard } from '$lib/pipeline/cards';
	import type { SkeletonCard } from '$lib/pipeline';
	import { formatRel } from '$lib/shell.svelte';
	import PublisherChip from './PublisherChip.svelte';
	import { IconClock, IconFile, IconLink, IconPencil } from '@tabler/icons-svelte';

interface Props {
	/** Skeleton during fetch (rule 5), ProductCard once assembled. */
	card: ProductCard | SkeletonCard;
	/** True while a fill lane has claimed this card but not yet merged it
	 * (issue #59) — renders the whole-card neutral sweep (issue #82) instead
	 * of the old `interpreting…` badge text. */
	pending?: boolean;
	/** True when a fill lane claimed this card but settled it uninterpreted
	 * this pass (issue #82) — the persistent amber-tint state. Sourced from
	 * the transient investigation.failed set: a later successful pass drains
	 * it; deliberate aborts never mark (killed ≠ failed, spec §8). */
	failed?: boolean;
	/** The drawer's current subject (issue #29a ruling 2): the G1:1063 accent
	 * ring marks selection on this surface — color + halo via box-shadow only,
	 * so the ring never reflows the list. */
	selected?: boolean;
	onOpen?(): void;
}

let { card, pending = false, failed = false, onOpen, selected = false }: Props = $props();

const product: ProductCard | null = $derived('identifiers' in card ? card : null);
const dashed = $derived(product === null || !product.interpreted);

	/* Settle bloom (issue #82): flip detection with a null-triad — the first
	 * observed value is the card's FIRST STABLE PAINT and never blooms
	 * (cache-hit calm; motion marks change, not provenance). Only a genuine
	 * false→true flip mid-life earns the ~260ms whole-face crossfade. */
	let blooming = $state(false);
	let observed: boolean | null = null;
	$effect(() => {
		const now = product !== null && product.interpreted;
		if (observed === null) {
			observed = now;
			return;
		}
		if (now && !observed) blooming = true;
		observed = now;
	});

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
	together by construction (only when onOpen), so the two a11y rules
	below are false positives here. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
	role={onOpen !== undefined ? 'button' : undefined}
	tabindex={onOpen !== undefined ? 0 : undefined}
	onclick={open}
	onkeydown={keyOpen}
	aria-busy={pending ? true : undefined}
	class="relative rounded-[12px] border px-4 py-3.5 transition-shadow duration-150
		{failed ? 'bg-orange-tint' : 'bg-surface'}
		{selected ? 'border-accent' : dashed ? 'border-dashed border-line-strong' : 'border-line'}
		{blooming && !selected ? 'settle-border' : ''}
		{selected
			? 'shadow-[0_0_0_4px_var(--accent-tint),0_8px_20px_-8px_rgba(15,23,42,0.2)]'
			: 'shadow-[0_1px_2px_rgba(15,23,42,0.05)]'}
		{onOpen !== undefined ? 'cursor-pointer' : ''}
		{onOpen !== undefined && !selected ? 'hover:shadow-raised' : ''}
		[content-visibility:auto] [contain-intrinsic-size:auto_150px]"
>
	{#if blooming && product !== null}
		<!-- whole-face crossfade (issue #82): the interpreted face mounts
			underneath immediately; the DASHED face floats on top and fades out
			over its background — the card honestly reads as a replacement,
			never a transformation of the machine text into the AI text. -->
		{@render liveFace(product)}
		<div class="settle-face-over" onanimationend={() => (blooming = false)}>
			{@render dashedFace()}
		</div>
	{:else if dashed}
		{@render dashedFace()}
	{:else if product !== null}
		{@render liveFace(product)}
	{/if}
	{#if pending}
		<!-- pending = the whole card sweeps (issue #82 ruling): a NEUTRAL
			diagonal wash on top of the true fallback face — the claim carries
			no color it hasn't earned, and no badge text is needed when the
			surface itself says "enrichment in flight". -->
		<div class="fill-sweep pointer-events-none absolute inset-0 rounded-[12px]" aria-hidden="true"></div>
	{/if}
</article>

{#snippet dashedFace()}
	<!-- fetch-stage skeleton ≡ settled rule-5 fallback ≡ AI down/timed-out
		chunk (spec §2 rule 5): the event's own tags + first chars, badge on. -->
	<div class="flex items-center gap-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-ink">
			{fallbackTitle}
		</h3>
		{#if product?.retracted}
			<span class="shrink-0 rounded-full border border-red-tint bg-red-tint px-2.5 py-0.5 font-mono text-[11px] font-medium text-red">
				retracted
			</span>
		{/if}
		{#if failed}
			<!-- amber = the lane CLAIMED this card and lost it this pass
				(issue #82) — visibly distinct from the never-claimed raw state,
				earned vocabulary, never decoration. -->
			<span
				class="shrink-0 rounded-full border border-orange-line px-2 py-0.5 font-mono text-[10.5px] text-orange"
			>
				not interpreted
			</span>
		{:else if !pending}
			<span
				class="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-ink-3"
			>
				not interpreted
			</span>
		{/if}
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
{/snippet}

{#snippet liveFace(p: ProductCard)}
	<!-- interpreted (BIBLE J2) -->
	<div class="flex items-center gap-2.5">
		<h3 class="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink">{p.title}</h3>
		{#if p.retracted}
			<!-- spec §2 rule 2: status is protocol-computed, never AI -->
			<span class="shrink-0 rounded-full border border-[oklch(0.93_0.04_20)] bg-red-tint px-2.5 py-0.5 font-mono text-[11px] font-medium text-red">
				retracted
			</span>
			<span class="shrink-0 font-mono text-[11px] text-ink-2">as relays returned</span>
		{/if}
	</div>
	{#if p.snippet !== undefined}
		<p class="mt-1 text-[13.5px] leading-relaxed text-ink-2">{p.snippet}</p>
	{/if}
	{#if shownIdentifiers.length > 0}
		<div class="mt-2.5 flex flex-wrap items-center gap-1.5">
			{#each shownIdentifiers as id (id)}
				<span class="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
					{id}
				</span>
			{/each}
			{#if extraIdentifiers > 0}
				<span class="font-mono text-[10px] text-ink-3">+{extraIdentifiers}</span>
			{/if}
		</div>
	{/if}
	{@render cardFoot(p)}
{/snippet}

{#snippet cardFoot(c: ProductCard)}
	<!-- BIBLE J2 hairline-split footer: publisher chip + event age +
		deterministic counts (spec §2 rule 2; icons per §9 anatomy) -->
	<div class="mt-3 flex items-center gap-2.5 border-t border-line pt-2.5 text-[12px] text-ink-2">
		<PublisherChip pubkey={c.pubkey} />
		<span class="inline-flex items-center gap-1.5">
			<IconClock size={12} stroke={2} aria-hidden="true" />
			<span class="font-mono text-[11px]">{formatRel(c.createdAt * 1000)}</span>
		</span>
		<span class="flex-1"></span>
		<span class="inline-flex shrink-0 items-center gap-2 font-mono text-[11px] text-ink-2">
			<!-- One icon pair across node + card (issue #77, pinned §9):
				IconFile = bound records (metadata), IconLink = artifacts
				(pdf/csv/…) — the two surfaces must never disagree. -->
			{#if c.files > 0}
				<span class="inline-flex items-center gap-1">
					<IconLink size={12} stroke={1.8} aria-hidden="true" />
					{c.files} file{c.files === 1 ? '' : 's'}
				</span>
			{/if}
			<span class="inline-flex items-center gap-1">
				<IconFile size={12} stroke={1.8} aria-hidden="true" />
				{c.boundMetadata} metadata
			</span>
			{#if c.updates > 0}
				<span class="inline-flex items-center gap-1">
					<IconPencil size={12} stroke={1.8} aria-hidden="true" />
					{c.updates} update{c.updates === 1 ? '' : 's'}
				</span>
			{/if}
		</span>
	</div>
{/snippet}

<style>
	/* Bloom mechanics (issue #82): the departing dashed face floats over the
	 * mounted interpreted face and fades; the sweep keyframes + border-hold
	 * live in app.css's shared fill grammar. 260ms width = the ruling's
	 * crossfade habit. Reduced-motion: the global floor in app.css zeroes
	 * these, and the bloom state still exits on the (now-instant) animationend. */
	.settle-face-over {
		position: absolute;
		inset: 0;
		padding: 14px 16px;
		border-radius: 12px;
		background: var(--surface);
		animation: settle-fade-out 260ms var(--ease-link) both;
		pointer-events: none;
	}
	.settle-border {
		animation: settle-border 260ms var(--ease-link) both;
	}
</style>
