<script lang="ts" module>
	import type { SubjectGraphNode } from '$lib/graph/subject-graph';

	/* Exported for GraphCanvas — the data contract every node receives
	 * (derivation anatomy + canvas-injected state + verb callbacks). */
	export interface GraphNodeData extends SubjectGraphNode {
		selected: boolean;
		/** Citation palette slot (0–5) when the chat cites this event. */
		citationIndex: number | null;
	/** Spotlight hover state — the ring lights with the pill (#30). */
	citationLit: boolean;
	onSelect: (id: string) => void;
	onExpand: (id: string) => void;
	/** Dense-mode only: canvas-level mirror so edge clipping follows the
	 * hover-escalated card size, never renders under it (§9 "forces full
	 * detail at any zoom"). Optional: other consumers don't provide it. */
	onHoverChange?: (id: string, hovered: boolean) => void;
}

	/** N4 → #99: below the density gate every node is FULL, always; past it,
	 * the ladder engages (full ≥ 0.6 · line ≥ 0.35 · disc below; escalations
	 * force full). The gate lives where the count is known (canvas). */
	export const DENSE_NODE_GATE = 40;
	const FLOOR_LINE = 0.6;
	const FLOOR_DISC = 0.35;

	type Tier = 'full' | 'line' | 'disc';

	export function tierOf(dense: boolean, zoom: number, forced: boolean): Tier {
		if (!dense || forced) return 'full';
		if (zoom >= FLOOR_LINE) return 'full';
		if (zoom >= FLOOR_DISC) return 'line';
		return 'disc';
	}

	/** Approximate model-space half-extents per tier/kind — the edge-clipping
	 * footprints (edges terminate at the card border, never pierce to the
	 * center). Widths are exact (w-[250px]/[230px]/[150px], h-7 w-7); heights
	 * are close approximations of the painted anatomy — tuned on the owner's
	 * feel pass, never geometry-correct. Only `full` varies by kind; the
	 * record's 64px height carries its added description line (§9 anatomy). */
	export const TIER_HALF: {
		full: Readonly<Record<SubjectGraphNode['kind'], { hw: number; hh: number }>>;
		line: { hw: number; hh: number };
		disc: { hw: number; hh: number };
	} = {
		full: {
			product: { hw: 125, hh: 62 },
			metadata: { hw: 115, hh: 64 }
		},
		line: { hw: 75, hh: 16 },
		disc: { hw: 14, hh: 14 }
	};
</script>

<script lang="ts">
	/* GRAPH NODE (#29b → #95 engine swap) — the canvas's per-event surface.
	 * Anatomy is BIBLE-locked, never improvised; identical markup to the
	 * xyflow era. What changed: the component is a plain DOM card now —
	 * no nodeType registration, no handles, no useViewport. Zoom arrives as
	 * a prop; position lives on the canvas's wrapper (physics owns it).
	 *
	 * BIBLE rules this component still carries:
	 *  - N1: subject (product) = tinted 30px tile + title + publisher +
	 *    one-line description + footer (time · edited ×N · icon-number
	 *    counts); a linked record (metadata) omits counts but now carries
	 *    the same one-line description (§9 anatomy) from its node-tile
	 *    label, and its card is a document — round tile, folded corner.
	 *  - N3 states: retracted = dashed red border + hatch + struck title;
	 *    uninterpreted = mono rule-5 title (§9 writing rule); related
	 *    product = dimmed + +N badge (admitted-but-hidden neighbors).
	 *  - N4 zoom ladder: floors full/line/disc; selected / hovered /
	 *    citation-lit break every floor (forced full).
	 *  - Chain word: one amber footer word, verbatim from core resolve().
	 *  - Rings: selection = accent ring; citation spotlight = --cite hue
	 *    OUTSIDE the accent. Hover never touches store state. */

	import { IconClock, IconFile, IconLink } from '@tabler/icons-svelte';
	import { iconForNode } from '$lib/graph/icons';
	import PublisherChip from '../ui/PublisherChip.svelte';
	import KeyHint from '../shell/KeyHint.svelte';
	import { firstPaintBloom } from '../ui/bloom.svelte';
	import { formatRel } from '$lib/shell.svelte';
	import { TERM_ARTIFACTS, TERM_BOUND_RECORDS } from '$lib/terms';

	interface Props {
		data: GraphNodeData;
		/** Rendered zoom (model px → screen px). Comes from the canvas camera. */
		zoom: number;
		/** True past the density gate (#99): tiers engage; false = always full. */
		dense: boolean;
	}
	const { data, zoom, dense }: Props = $props();

	// Local-only interaction state: hover escalates detail (N4, dense mode
	// only) without ever touching store state (spotlight's own rule).
	let hovered = $state(false);

	const forced = $derived(data.selected || hovered || data.citationLit);
	const tier = $derived(tierOf(dense, zoom, forced));

	// Interpreted → the model's icon token (machine-mapped to a glyph,
	// icons.ts); fallback → deterministic i-prefix → kind default (N2).
	const mapping = $derived(iconForNode(data.kind, data.event, data.typeToken));
	const IconComponent = $derived(mapping.icon);
	/** §9 anatomy: the glyph hue names the kind — accent blue for a product,
	 * orange for a record. Warn rides the tile stroke (below), so the orange
	 * glyph is the only warn carrier on either kind. */
	const glyphClass = $derived(
		mapping.warn || data.kind !== 'product' ? 'text-[var(--orange)]' : 'text-accent-ink'
	);

	/* Tile-settle (issue #82): the node-trickle UPGRADES this node in place —
	 * a false→true `interpreted` flip earns one ~200ms settle-fade on title +
	 * glyph. Dense full/line tiers only — the disc tier's instant glyph pop
	 * stands by #29c ruling as of #82. */
	const bloom = firstPaintBloom(() => data.interpreted);

	/** Ring stack: box-shadow paints FIRST-listed TOPMOST — accent leads
	 * (selection must survive citation-lit), the cite hue trails at 6px so it
	 * shows only as the outer band; the tint halo is for the unselected lit
	 * case (accent covers it otherwise). */
	const ringStyle = $derived.by(() => {
		const layers: string[] = [];
		if (data.selected) layers.push('0 0 0 4px var(--accent-tint)');
		if (data.citationLit && data.citationIndex !== null) {
			if (!data.selected) layers.push(`0 0 0 4px var(--cite-${data.citationIndex}-tint)`);
			layers.push(`0 0 0 6px var(--cite-${data.citationIndex})`);
		}
		layers.push('0 1px 2px rgba(15, 23, 42, 0.05)');
		return layers.join(', ');
	});

	/* Card surface fill, composed as ONE background shorthand: the inline
	 * shorthand wins over any class background, so the document-fold hairline
	 * and the retracted stripes must be layered here together or the stripes
	 * would wipe the hairline. Layer order is first-listed topmost: hairline
	 * over stripes/surface. The hairline is a 45° gradient whose stop sits at
	 * (14/√2 + 1)px so its colored half hugs the diagonal cut (§9 anatomy);
	 * a retracted record's hairline is --red to match its dashed border. */
	const cardBackground = $derived.by(() => {
		const isDocument = data.kind === 'metadata' && tier !== 'disc';
		// 14/√2 + 1 puts the colored half exactly on the diagonal cut.
		const hairline = isDocument
			? `linear-gradient(-135deg, var(${data.retracted ? '--red' : '--line'}) calc(0.707 * 14px + 1px), transparent 0)`
			: undefined;
		const fill = data.retracted
			? 'repeating-linear-gradient(45deg, var(--red-tint) 0 6px, var(--surface) 6px 12px)'
			: 'var(--surface)';
		return [hairline, fill].filter(Boolean).join(', ');
	});

	/** Time footer pieces (mono, machine-made — §9 writing rule). Hues are
	 * boarded: the retracted word is N3's RED, chain words stay amber. */
	const footerBits = $derived.by(() => {
		const bits: { text: string; tone: 'red' | 'amber' | null }[] = [];
		if (data.retracted) bits.push({ text: 'retracted', tone: 'red' });
		if (data.editedN > 0) bits.push({ text: `edited ×${data.editedN}`, tone: null });
		if (data.chainWord !== null) bits.push({ text: data.chainWord, tone: 'amber' });
		return bits;
	});

	function keySelect(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			data.onSelect(data.id);
		}
	}
</script>

<!-- The node IS one select target (ruling 6: drawer-only detail), accepted
 *	via the canvas wrapper's pointerdown (press-to-select, #101). No mouse
 *	onclick here on purpose: it would DOUBLE-fire openDossier after the
 *	pointerdown (duplicated relay legs per click — review F2, #102). The
 *	keyboard path (Enter/Space) stays on keySelect. The +N bubble is the
 *	expansion gesture (#97): single-click, discrete hit target — it never
 *	selects. -->
<!-- The title is CSS-clipped (truncate) and the dense tiers drop it, so the
	 * tooltip carries the full text in the same face as the visible title. -->
{#snippet fullTitle()}
	<span class={data.interpreted ? '' : 'font-mono break-all'}>{data.title}</span>
{/snippet}

<!-- The title tip sits on the title text (full and line tiers) or the disc
	 * icon, never on the whole card: a tip on the card would swallow the
	 * pointer-enter after a child tip (publisher chip, counts, +N bubble)
	 * closed, so moving back to the title showed nothing until the pointer
	 * left the card. The full title is in the node's accessible name and opens
	 * in the Dossier on Enter/Space, so the tip is a mouse supplement
	 * (hoverOnly) by design: a child of an interactive parent gets no tab
	 * stop (spec §9 keyboard rule, #39). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- §9 anatomy: a linked record is a DOCUMENT — its card is clipped at the
 * top-right corner with a 14px diagonal cut and a folded flap. The clip must
 * live on an INNER surface: clip-path on the ring element would notch the
 * selection/citation box-shadows, and it would swallow the +N badge. The
 * outer wrapper therefore carries ONLY the ring and the badge; the inner
 * card carries the radius, the border, the surface/stripes, the fold clip,
 * the diagonal hairline and the content. -->
<div
	role="button"
	tabindex="0"
	aria-label={tier === 'disc' ? data.title : undefined}
	onkeydown={keySelect}
	onmouseenter={() => {
		hovered = true;
		data.onHoverChange?.(data.id, true);
	}}
	onmouseleave={() => {
		hovered = false;
		data.onHoverChange?.(data.id, false);
	}}
	class="graph-node relative text-left transition-shadow duration-150
		{tier === 'full' ? (data.kind === 'product' ? 'w-[250px] rounded-[12px]' : 'w-[230px] rounded-[12px]') : ''}
		{tier === 'line' ? 'w-[150px] rounded-[9px]' : ''}
		{tier === 'disc' ? 'h-7 w-7 rounded-full' : ''}
		{data.role === 'related' && !data.retracted ? 'opacity-70' : ''}
		{hovered || data.selected ? 'shadow-raised' : ''}"
	style:box-shadow={ringStyle}
>
	{#if tier === 'disc'}
		<!-- The disc stays a circle for both kinds — no fold (§9 anatomy: the
			document cut only exists where there is a card to fold). The root
			button's aria-label names it; this wrapper is the tip trigger so the
			+N bubble is its sibling, not a child. -->
		<div
			class="flex h-full w-full items-center justify-center rounded-full border bg-surface
				{data.retracted ? 'border-2 border-dashed border-[var(--red)]' : data.selected ? 'border-accent' : 'border-line'}"
			style:background={cardBackground}
		>
			<KeyHint hoverOnly nameless side="right" content={fullTitle}>
				{#snippet trigger({ props })}
					<span {...props} class="flex h-full w-full items-center justify-center rounded-full">
						<IconComponent size={14} stroke-width={1.8} class={glyphClass} />
					</span>
				{/snippet}
			</KeyHint>
		</div>
	{:else if tier === 'line'}
		<!-- Line tier stays title-only (§9 anatomy): the description line is a
			full-tier affordance. A record still folds here — the cut is the kind
			mark, independent of how much text the tier carries. -->
		<div
			class="flex items-center gap-1.5 rounded-[9px] border px-2 py-1.5
				{data.kind === 'metadata' ? 'doc-cut' : ''}
				{data.retracted ? 'border-2 border-dashed border-[var(--red)]' : data.selected ? 'border-accent' : 'border-line'}"
			style:background={cardBackground}
		>
			<span
				class="flex h-[18px] w-[18px] shrink-0 items-center justify-center border
					{data.kind === 'product'
					? 'rounded-md border-[var(--accent)]/30 bg-accent-tint'
					: 'rounded-full border-line bg-inset'}
					{mapping.warn && !data.retracted ? 'border-[var(--orange)]' : ''}
					{bloom.active ? 'settle-flip' : ''}"
				onanimationend={() => bloom.clear()}
			>
				<IconComponent
					size={10}
					stroke-width={1.8}
					class={glyphClass}
				/>
			</span>
			<KeyHint hoverOnly nameless side="right" content={fullTitle}>
				{#snippet trigger({ props })}
					<span
						{...props}
						class="truncate font-mono text-[10px] {data.retracted ? 'text-ink-3 line-through' : 'text-ink-2'} {bloom.active ? 'settle-flip' : ''}"
						>{data.title}</span
					>
				{/snippet}
			</KeyHint>
			{#if data.kind === 'metadata'}<span aria-hidden="true" class="doc-flap"></span>{/if}
		</div>
	{:else}
		<!-- full tier (N1) -->
		<div
			class="rounded-[12px] border
				{data.kind === 'product' ? 'px-3 py-2.5' : 'doc-cut px-2.5 py-2'}
				{data.retracted ? 'border-2 border-dashed border-[var(--red)]' : data.selected ? 'border-accent' : 'border-line'}"
			style:background={cardBackground}
		>
			<div class="flex items-center {data.kind === 'product' ? 'gap-2.5' : 'gap-2'}">
				<span
					class="relative flex shrink-0 items-center justify-center border
						{data.kind === 'product'
						? 'h-[30px] w-[30px] rounded-lg border-[var(--accent)]/30 bg-accent-tint'
						: 'h-[26px] w-[26px] rounded-full border-line bg-inset'}
						{data.retracted ? 'border-[var(--red)]' : ''}
						{mapping.warn && !data.retracted ? 'border-[var(--orange)]' : ''}
						{bloom.active ? 'settle-flip' : ''}"
					onanimationend={() => bloom.clear()}
				>
					<IconComponent
						size={data.kind === 'product' ? 16 : 14}
						stroke-width={1.7}
						class={glyphClass}
					/>
				</span>
				<div class="min-w-0">
					<KeyHint hoverOnly nameless side="right" content={fullTitle}>
						{#snippet trigger({ props })}
							<div
								{...props}
								class="truncate font-semibold {data.kind === 'product' ? 'text-[13.5px]' : 'text-[13px]'}
									{data.interpreted ? 'font-sans' : 'font-mono text-[11.5px]'}
									{data.retracted ? 'text-ink-3 line-through' : 'text-ink'}
									{bloom.active ? 'settle-flip' : ''}"
							>
								{data.title}
							</div>
						{/snippet}
					</KeyHint>
					<!-- N5: publisher name ALWAYS (npub fallback mono inside the chip);
						the avatar badge lives in the chip itself. -->
					<PublisherChip pubkey={data.pubkey} />
				</div>
			</div>

			{#if data.snippet !== undefined}
				<!-- §9 anatomy: one description line on both kinds (a product's card
					snippet, a record's node-tile label). It only ever exists on an
					interpreted node — an uninterpreted one has no description, because
					its rule-5 title already IS the first content line. -->
				<p class="mt-1.5 truncate text-[12px] leading-[1.5] text-ink-2">
					{data.snippet}
				</p>
			{/if}

			{#if data.role === 'related'}
				<p class="mt-1 text-[10px] text-ink-3">related product · click +{data.badge ?? 'N'} to expand</p>
			{/if}

			<div
				class="mt-2 flex items-center gap-2.5 border-t border-line/60 pt-1.5 font-mono text-[10.5px] text-ink-2"
			>
				<!-- event created_at is SECONDS; formatRel speaks ms (drawer/card
					convention, same conversion). -->
				<span class="flex items-center gap-1"><IconClock size={11} stroke-width={2} />{formatRel(data.createdAt * 1000)}</span
				>
				{#each footerBits as bit (bit.text)}
					<span
						class={bit.tone === 'amber'
							? 'font-medium text-[var(--orange)]'
							: bit.tone === 'red'
								? 'font-medium text-[var(--red)]'
								: ''}>{bit.text}</span
					>
				{/each}
				{#if data.kind === 'product'}
					<!-- Icon pair pinned with ResultCard (§9): IconFile =
						bound records, IconLink = artifacts named by the record or its
							bound records (TERM_ARTIFACTS, issue #77). -->
					<!-- Hover-only: the card is the focusable target, so the
						sr-only words carry the meaning for assistive tech. -->
					<KeyHint hoverOnly nameless label={TERM_BOUND_RECORDS}>
						{#snippet trigger({ props })}
							<span {...props} class="ml-auto flex items-center gap-1"
								><IconFile size={11} stroke-width={2} aria-hidden="true" />{data.boundMetadata}<span class="sr-only"> bound records</span></span
							>
						{/snippet}
					</KeyHint>
					<KeyHint hoverOnly nameless label={TERM_ARTIFACTS}>
						{#snippet trigger({ props })}
							<span {...props} class="flex items-center gap-1"
								><IconLink size={11} stroke-width={2} aria-hidden="true" />{data.files}<span class="sr-only"> artifacts</span></span
							>
						{/snippet}
					</KeyHint>
				{/if}
			</div>
			{#if data.kind === 'metadata'}<span aria-hidden="true" class="doc-flap"></span>{/if}
		</div>
	{/if}

	<!-- N3/G1 → #97: admitted-but-hidden neighbors (never zero-shown). The
	 * bubble is the expansion verb — single click, discrete hit target,
	 * never a selection. Meaning is role-bound: records hide PRODUCT
	 * bridges, relateds hide RECORDS. -->
	{#if data.badge !== null}
		<!-- The visible "+N" is not a name: the label says what expands. -->
		<KeyHint
			label={data.role === 'related'
				? `Expand: ${data.badge} admitted ${data.badge === 1 ? 'record' : 'records'} hidden`
				: `Expand: ${data.badge} related ${data.badge === 1 ? 'product' : 'products'} hidden`}
			class="absolute -bottom-2 -right-2 flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-line bg-surface font-mono text-[9px] font-semibold text-ink-2 transition-colors hover:border-accent"
			onclick={(e) => {
				e.stopPropagation();
				data.onExpand(data.id);
			}}
			onpointerdown={(e) => e.stopPropagation()}
			>+{data.badge}</KeyHint
		>
	{/if}
</div>

<!-- The bloom mark is the shared `.settle-flip` class (app.css, issue #82) —
	the single ~200ms "graph updated" on trickle merge, one motion vocabulary. -->

<style>
	/* Keyboard ring (issue #127): the node's SELECTED state already paints an
	 * --accent border + citation ring, so the generic :focus-visible ring sat
	 * flush against it and focus read as selection. Lift it clear. Scoped here
	 * rather than on `.stage [role="button"]` in app.css: an ancestor selector
	 * silences on any rename and would leak onto future stage buttons. */
	.graph-node:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	/* Document fold (§9 anatomy): a linked record is a document, so its card
	 * is clipped at the top-right corner with a 14px diagonal cut. The 12px
	 * border-radius survives because the rounded corners sit INSIDE this
	 * polygon. The cut lives on the inner card, never on the ring wrapper —
	 * clip-path there would notch the selection/citation box-shadows and
	 * swallow the +N badge. The disc tier keeps its circle and gets no fold. */
	.doc-cut {
		position: relative;
		clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%);
	}

	/* The border cannot follow the diagonal, so the hairline is painted as a
	 * background layer — composed in `cardBackground` alongside the retracted
	 * stripes, because the inline background shorthand would otherwise wipe
	 * any class-level background-image. */

	/* The folded flap: the little triangle of paper left just under the cut.
	 * It must sit on the KEPT side of the diagonal — the lower-left half of
	 * the 14px corner box — because the clip polygon already removed the
	 * upper-right half; a flap painted there would be invisible. So the fill
	 * is a +45deg gradient (fills toward the bottom-left), with a --line
	 * hypotenuse running along the same diagonal as the cut. Decorative only;
	 * this is what reads as a paper fold rather than a chamfer. */
	.doc-flap {
		position: absolute;
		top: 0;
		right: 0;
		width: 14px;
		height: 14px;
		background:
			linear-gradient(45deg, transparent calc(50% - 0.75px), var(--line) calc(50% - 0.75px), var(--line) calc(50% + 0.75px), transparent calc(50% + 0.75px)),
			linear-gradient(45deg, var(--inset) 50%, transparent 50%);
		pointer-events: none;
	}
</style>
