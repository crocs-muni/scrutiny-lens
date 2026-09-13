<script lang="ts">
	/* RESULT CARD — P3 anatomy per BIBLE J2 (issue #38, spec §9 + §2 rule 5).
	 *
	 * Variants:
	 *   interpreted     — title (sans 14.5/600) + snippet (sans 13.5, lh 1.55);
	 *                     mono id chips; hairline-split footer (publisher chip
	 *                     + event-age clock + icon counts); share icon copies
	 *                     the raw `nevent` (#31 will own the full share route).
	 *   not interpreted — dashed border, event's own tags + first chars,
	 *                     "not interpreted" badge; same footer (publisher +
	 *                     metadata/files/updates counts are deterministic,
	 *                     never AI). While a fill lane holds the card's id in
	 *                     investigation.pending (claimed, not merged), the badge
	 *                     reads "interpreting…" — #59's third state. Chose
	 *                     `pending` over "interpreting" because the Investigation
	 *                     field names the lane-side SETTLE signal (in-flight
	 *                     claims), and only the badge TEXT speaks user UI
	 *                     vocabulary; same split as `filling` / "AI slow…".
	 *   retracted       — either variant + red warning pill (protocol kind-5,
	 *                     never presentational, spec §2 rule 2); retracted
	 *                     interpreted cards name their provenance ("as relays
	 *                     returned") in place of the share action. */

	import type { ProductCard } from '$lib/pipeline/cards';
	import type { SkeletonCard } from '$lib/pipeline';
	import { formatRel } from '$lib/shell.svelte';
	import { nip19 } from 'nostr-tools';
	import PublisherChip from './PublisherChip.svelte';
	import { IconCheck, IconClock, IconFile, IconLink, IconPencil, IconShare } from '@tabler/icons-svelte';

interface Props {
	/** Skeleton during fetch (rule 5), ProductCard once assembled. */
	card: ProductCard | SkeletonCard;
	/** True while a fill lane has claimed this card but not yet merged it
	 * (issue #59). The dashed variant reads `interpreting…` instead of
	 * `not interpreted` — the never-lie gap (spec §2): a card 8s into a
	 * 14s call must not read identically to one that will never be
	 * interpreted. */
	pending?: boolean;
	/** The drawer's current subject (issue #29a ruling 2): the G1:1063 accent
	 * ring marks selection on this surface — color + halo via box-shadow only,
	 * so the ring never reflows the list. */
	selected?: boolean;
	onOpen?(): void;
}

let { card, pending = false, onOpen, selected = false }: Props = $props();

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

	let shared = $state(false);
	async function share(): Promise<void> {
		if (product === null) return;
		// Deep link to the raw event (issue #31's shape); copy the address —
		// the card never opens anything outside the user's own clipboard.
		const nevent = nip19.neventEncode({ id: product.id, author: product.pubkey });
		await navigator.clipboard.writeText(nevent);
		shared = true;
		setTimeout(() => (shared = false), 1500);
	}

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
	class="rounded-[12px] border bg-surface px-4 py-3.5 transition-shadow duration-150
		{selected ? 'border-accent' : dashed ? 'border-dashed border-line-strong' : 'border-line'}
		{selected
			? 'shadow-[0_0_0_4px_var(--accent-tint),0_8px_20px_-8px_rgba(15,23,42,0.2)]'
			: 'shadow-[0_1px_2px_rgba(15,23,42,0.05)]'}
		{onOpen !== undefined ? (selected ? 'cursor-pointer' : 'cursor-pointer hover:shadow-raised') : ''}
		[content-visibility:auto] [contain-intrinsic-size:auto_150px]"
>
	{#if dashed}
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
			<span
				class="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-ink-3"
			>
				<!-- mid-fill raw ≠ settled raw (spec §2): the fill lane's own
					claim writes `interpreting…`; once the lane settles this id
					leaves pending and the badge reverts, no ghost state. -->
				{pending ? 'interpreting…' : 'not interpreted'}
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
		<!-- interpreted (BIBLE J2) -->
		<div class="flex items-center gap-2.5">
			<h3 class="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink">{product.title}</h3>
			{#if product.retracted}
				<!-- spec §2 rule 2: status is protocol-computed, never AI -->
				<span class="shrink-0 rounded-full border border-[oklch(0.93_0.04_20)] bg-red-tint px-2.5 py-0.5 font-mono text-[11px] font-medium text-red">
					retracted
				</span>
				<span class="shrink-0 font-mono text-[11px] text-ink-2">as relays returned</span>
			{:else}
				<!-- share: copies the raw event address (nevent) -->
				<button
					type="button"
					aria-label="Copy share link"
					title={shared ? 'copied' : 'Copy share link'}
					class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-ink-2 hover:bg-inset"
					onclick={(e) => {
						e.stopPropagation();
						void share();
					}}
				>
					{#if shared}
						<IconCheck size={13} stroke={2} />
					{:else}
						<IconShare size={13} stroke={2} />
					{/if}
				</button>
			{/if}
		</div>
		{#if product.snippet !== undefined}
			<p class="mt-1 text-[13.5px] leading-relaxed text-ink-2">{product.snippet}</p>
		{/if}
		{#if shownIdentifiers.length > 0}
			<div class="mt-2.5 flex flex-wrap items-center gap-1.5">
				{#each shownIdentifiers as id (id)}
					<span
						class="rounded-[6px] border border-line bg-inset px-2 py-[3px] font-mono text-[11px] text-ink-2"
					>
						{id}
					</span>
				{/each}
				{#if extraIdentifiers > 0}
					<span class="font-mono text-[11px] text-ink-3">+{extraIdentifiers}</span>
				{/if}
			</div>
		{/if}
		{@render cardFoot(product)}
	{/if}
</article>

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
			{#if c.files > 0}
				<span class="inline-flex items-center gap-1">
					<IconFile size={12} stroke={1.8} aria-hidden="true" />
					{c.files} file{c.files === 1 ? '' : 's'}
				</span>
			{/if}
			<span class="inline-flex items-center gap-1">
				<IconLink size={12} stroke={1.8} aria-hidden="true" />
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
