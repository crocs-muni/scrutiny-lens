<script lang="ts">
	import { FileText, Crosshair, Wrench } from '@lucide/svelte';
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
			metaType?: 'report' | 'target' | 'maintenance';
			retracted?: boolean;
			isRoot?: boolean;
			expanded?: boolean;
			hiddenCount?: number;
			rarity?: number;
			citationRing?: boolean;
			citationBadge?: number | null;
			onToggleExpand?: () => void;
		};
	}

	let { data }: Props = $props();

	const Icon = $derived(data.metaType === 'maintenance' ? Wrench : data.metaType === 'target' ? Crosshair : FileText);
	const iconColor = $derived(data.metaType === 'target' ? 'text-info' : 'text-destructive');

	// Rarity-driven orange saturation: common/boilerplate metadata (e.g. a
	// shared CC SAR component bound to hundreds of certificates) renders
	// washed-out; rare/unique metadata (e.g. this cert's own Security Target)
	// renders vivid. Uses color-mix() the same way the codebase already uses
	// inline arbitrary-value styles for the retracted hatched background.
	// Selection keeps its own primary-color ring/border on top; retraction
	// fully overrides to its own hatched treatment (a stronger signal than
	// rarity), so neither of those branches reads `rarityPct`.
	const rarityPct = $derived(Math.round((data.rarity ?? 1) * 100));
	const rarityBorder = $derived(`border-color: color-mix(in oklch, #fed7aa, #ea580c ${rarityPct}%);`);
</script>

<div
	class="relative w-48 rounded-[var(--radius-lg)] border-2 bg-card p-3 shadow-md transition {data.retracted
		? 'border-dashed border-destructive bg-[repeating-linear-gradient(135deg,#fff,#fff_8px,#fafafa_8px,#fafafa_16px)]'
		: data.selected
			? 'border-primary ring-4 ring-primary/[0.15]'
			: ''} {data.citationRing ? 'ring-[6px] ring-primary/[0.18]' : ''}"
	style={data.retracted || data.selected ? undefined : rarityBorder}
>
	<Handle type="source" position={Position.Top} style="opacity: 0; pointer-events: none;" />
	<Handle type="source" position={Position.Right} style="opacity: 0; pointer-events: none;" />
	<Handle type="source" position={Position.Bottom} style="opacity: 0; pointer-events: none;" />
	<Handle type="source" position={Position.Left} style="opacity: 0; pointer-events: none;" />
	{#if data.citationBadge}
		<span
			class="absolute -left-2 -top-2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground shadow-sm"
		>
			source of [{data.citationBadge}]
		</span>
	{/if}
	{#if !data.isRoot && data.expanded}
		<button
			type="button"
			onclick={(e) => {
				e.stopPropagation();
				data.onToggleExpand?.();
			}}
			class="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-[11px] font-semibold leading-none text-muted-foreground shadow-sm hover:text-primary"
			aria-label="Collapse neighbors"
		>
			&minus;
		</button>
	{:else if !data.isRoot && (data.hiddenCount ?? 0) > 0}
		<button
			type="button"
			onclick={(e) => {
				e.stopPropagation();
				data.onToggleExpand?.();
			}}
			class="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-muted px-1 text-[11px] font-semibold leading-none text-muted-foreground shadow-sm hover:text-primary"
			aria-label="Expand neighbors"
		>
			+{data.hiddenCount}
		</button>
	{/if}
	<div class="flex items-start gap-2">
		<div class="mt-0.5 shrink-0 {data.retracted ? 'text-destructive' : iconColor}">
			<Icon class="h-4 w-4" />
		</div>
		<div class="min-w-0 flex-1">
			<h4 class="text-[13px] font-semibold leading-tight {data.retracted ? 'text-muted-foreground line-through' : 'text-card-foreground'}">
				{data.title}
			</h4>
			<p class="truncate text-[11px] text-muted-foreground">{data.subtitle}</p>
		</div>
	</div>
	{#if data.badges.length > 0}
		<div class="mt-2 flex flex-wrap gap-1">
			{#each data.badges.slice(0, 2) as badge}
				<code class="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{badge}</code>
			{/each}
		</div>
	{/if}
	{#if data.retracted}
		<span class="mt-2 inline-flex items-center rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white">Retracted</span>
	{/if}
</div>
