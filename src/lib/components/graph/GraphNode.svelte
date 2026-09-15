<script lang="ts" module>
	/* Exported for GraphCanvas (the nodeTypes map's data contract) — module
	 * script so the type may be exported. */
	export interface GraphNodeData extends SubjectGraphNode {
		selected: boolean;
		/** Citation palette slot (0–5) when the chat cites this event. */
		citationIndex: number | null;
		/** Spotlight hover state — the ring lights with the pill (#30). */
		citationLit: boolean;
		onSelect: (id: string) => void;
		onExpand: (id: string) => void;
	}
</script>

<script lang="ts">
	/* GRAPH NODE (#29b) — the canvas's per-event surface. Anatomy is
	 * BIBLE-locked, never improvised:
	 *
	 *  - N1: subject (product) = tinted 30px tile + title + publisher +
	 *    one-line description + footer (time · edited ×N · icon-number
	 *    counts); a linked record (metadata) omits description and counts.
	 *  - N3 states: retracted = dashed red border + hatch + struck title;
	 *    uninterpreted = mono rule-5 title (§9 writing rule); related
	 *    product = dimmed + +N badge (admitted-but-hidden neighbors,
	 *    ruling 8).
	 *  - N4 zoom ladder: rendered zoom floors full → icon+mono line → icon
	 *    disc; selected / hovered / citation-lit break every floor.
	 *  - Chain word (ruling 9): one amber footer word, verbatim from core
	 *    resolve() via the subject graph — halted / forked / stopped at
	 *    limit. No pill.
	 *  - Rings: selection = accent (ruling 2/#29a); citation spotlight =
	 *    --cite hue OUTSIDE the accent (citations.css). Hover must never
	 *    change store-level state — hovered is component-local.
	 *
	 * xyflow contract: this component is the `scrutiny` nodeType. Eight
	 * invisible handles (source+target × four sides) let the subject graph's
	 * quadrant math attach edges to facing sides; ids `s-<side>` / `t-<side>`. */

	import { Handle, Position, useViewport, type NodeProps } from '@xyflow/svelte';
	import { IconClock, IconFile, IconLink } from '@tabler/icons-svelte';
	import type { SubjectGraphNode, HandleSide } from '$lib/graph/subject-graph';
	import { iconForNode } from '$lib/graph/icons';
	import PublisherChip from '../ui/PublisherChip.svelte';
	import { formatRel } from '$lib/shell.svelte';

	const props: NodeProps = $props();
	/* One documented cast at the xyflow seam: nodeTypes below pins `data` to
	 * GraphNodeData (xyflow types data as Record<string, unknown>). */
	const data = $derived(props.data as unknown as GraphNodeData);
	const id = $derived(props.id);

	const viewport = useViewport();
	/** N4 floors: full card ≥ 0.6 · icon+mono ≥ 0.35 · disc below. */
	const FLOOR_LINE = 0.6;
	const FLOOR_DISC = 0.35;

	// Local-only interaction state: hover escalates detail (N4) without ever
	// touching store state (spotlight's own rule for the same reason).
	let hovered = $state(false);

	const forced = $derived(data.selected || hovered || data.citationLit);
	const tier = $derived<'full' | 'line' | 'disc'>(
		forced || viewport.current.zoom >= FLOOR_LINE
			? 'full'
			: viewport.current.zoom >= FLOOR_DISC
				? 'line'
				: 'disc'
	);

	// Interpreted → the model's icon token (machine-mapped to a glyph,
	// icons.ts); fallback → deterministic i-prefix → kind default (N2).
	const mapping = $derived(iconForNode(data.kind, data.event, data.typeToken));
	const IconComponent = $derived(mapping.icon);

	/** Ring stack: box-shadow paints FIRST-listed TOPMOST — accent leads
	 * (selection must survive citation-lit, Spec finding a2), the cite hue
	 * trails at 6px so it shows only as the outer band; the tint halo is for
	 * the unselected lit case (accent covers it otherwise). */
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

	const expandable = $derived(data.role === 'related' && data.badge !== null);

	/** Time footer pieces (mono, machine-made — §9 writing rule). Hues are
	 * boarded: the retracted word is N3's RED, chain words stay amber. */
	const footerBits = $derived.by(() => {
		const bits: { text: string; tone: 'red' | 'amber' | null }[] = [];
		if (data.retracted) bits.push({ text: 'retracted', tone: 'red' });
		if (data.editedN > 0) bits.push({ text: `edited ×${data.editedN}`, tone: null });
		if (data.chainWord !== null) bits.push({ text: data.chainWord, tone: 'amber' });
		return bits;
	});

	const SIDES: [side: HandleSide, pos: Position][] = [
		['left', Position.Left],
		['right', Position.Right],
		['top', Position.Top],
		['bottom', Position.Bottom]
	];

	function keySelect(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			data.onSelect(id);
		}
	}
</script>

<!-- The node IS one click target (ruling 6: drawer-only detail); dbl-click
 *	is the expansion gesture (ruling 8) — Suppressed when there is nothing
 *	admitted to reveal. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	role="button"
	tabindex="0"
	title={data.title}
	onclick={() => data.onSelect(id)}
	onkeydown={keySelect}
	ondblclick={() => {
		if (expandable) data.onExpand(id);
	}}
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	class="rounded-[12px] border bg-surface text-left transition-shadow duration-150
		{tier === 'full' ? (data.kind === 'product' ? 'w-[250px] px-3 py-2.5' : 'w-[230px] px-2.5 py-2') : ''}
		{tier === 'line' ? 'flex w-[150px] items-center gap-1.5 rounded-[9px] px-2 py-1.5' : ''}
		{tier === 'disc' ? 'flex h-7 w-7 items-center justify-center rounded-full p-0' : ''}
		{data.retracted ? 'border-2 border-dashed border-[var(--red)]' : data.selected ? 'border-accent' : 'border-line'}
		{data.role === 'related' && !data.retracted ? 'opacity-70' : ''}
		{hovered || data.selected ? 'shadow-raised' : ''}"
	style:box-shadow={ringStyle}
	style:background={data.retracted
		? 'repeating-linear-gradient(45deg, var(--red-tint) 0 6px, var(--surface) 6px 12px)'
		: undefined}
>
	{#if tier === 'disc'}
		<IconComponent size={14} stroke-width={1.8} class={mapping.warn ? 'text-[var(--orange)]' : 'text-ink-2'} />
	{:else if tier === 'line'}
		<span
			class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border
				{data.kind === 'product' ? 'border-[var(--accent)]/30 bg-accent-tint' : 'border-line bg-inset'}"
		>
			<IconComponent
				size={10}
				stroke-width={1.8}
				class={mapping.warn ? 'text-[var(--orange)]' : data.kind === 'product' ? 'text-accent-ink' : 'text-ink-2'}
			/>
		</span>
		<span
			class="truncate font-mono text-[10px] {data.retracted ? 'text-ink-3 line-through' : 'text-ink-2'}"
			>{data.title}</span
		>
	{:else}
		<!-- full tier (N1) -->
		<div class="flex items-center {data.kind === 'product' ? 'gap-2.5' : 'gap-2'}">
			<span
				class="relative flex shrink-0 items-center justify-center rounded-lg border
					{data.kind === 'product' ? 'h-[30px] w-[30px] border-[var(--accent)]/30 bg-accent-tint' : 'h-[26px] w-[26px] border-line bg-inset'}
					{data.retracted ? 'border-[var(--red)]' : ''}"
			>
				<IconComponent
					size={data.kind === 'product' ? 16 : 14}
					stroke-width={1.7}
					class={mapping.warn ? 'text-[var(--orange)]' : data.kind === 'product' ? 'text-accent-ink' : 'text-ink-2'}
				/>
			</span>
			<div class="min-w-0">
				<div
					class="truncate font-semibold {data.kind === 'product' ? 'text-[13.5px]' : 'text-[13px]'}
						{data.interpreted ? 'font-sans' : 'font-mono text-[11.5px]'}
						{data.retracted ? 'text-ink-3 line-through' : 'text-ink'}"
				>
					{data.title}
				</div>
				<!-- N5: publisher name ALWAYS (npub fallback mono inside the chip);
					the avatar badge lives in the chip itself. -->
				<PublisherChip pubkey={data.pubkey} />
			</div>
		</div>

		{#if data.kind === 'product' && data.snippet !== undefined}
			<p class="mt-1.5 truncate text-[12px] leading-[1.5] text-ink-2">{data.snippet}</p>
		{/if}

		{#if data.role === 'related'}
			<p class="mt-1 text-[10px] text-ink-3">related product · dbl-click expands</p>
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
				<span class="ml-auto flex items-center gap-1" title="bound metadata"
					><IconFile size={11} stroke-width={2} />{data.boundMetadata}</span
				>
				<span class="flex items-center gap-1" title="files (linked artifacts)"
					><IconLink size={11} stroke-width={2} />{data.files}</span
				>
			{/if}
		</div>
	{/if}

	<!-- N3/G1: admitted-but-hidden neighbors (ruling 8) — never zero-shown. -->
	{#if data.badge !== null}
		<span
			class="absolute -bottom-2 -right-2 flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-line bg-surface font-mono text-[9px] font-semibold text-ink-2"
			title="{data.badge} admitted {data.badge === 1 ? 'neighbor' : 'neighbors'} hidden — double-click to expand"
			>+{data.badge}</span
		>
	{/if}

	<!-- Edge anchors (invisible): the subject graph's quadrant math keys source/target side. -->
	{#each SIDES as [side, pos] (side)}
		<Handle id="s-{side}" type="source" position={pos} class="!invisible" isConnectable={false} />
		<Handle id="t-{side}" type="target" position={pos} class="!invisible" isConnectable={false} />
	{/each}
</div>
