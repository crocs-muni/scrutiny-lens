<script lang="ts">
	import { Clock } from '@lucide/svelte';
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
			retracted?: boolean;
			isRoot?: boolean;
			expanded?: boolean;
			hiddenCount?: number;
			updateCount?: number;
			citationRing?: boolean;
			citationBadge?: number | null;
			onToggleExpand?: () => void;
		};
	}

	let { data }: Props = $props();
</script>

<div
	class="relative w-56 rounded-[var(--radius-lg)] border-2 bg-card p-3 shadow-md transition {data.retracted
		? 'border-dashed border-destructive bg-[repeating-linear-gradient(135deg,#fff,#fff_8px,#fafafa_8px,#fafafa_16px)]'
		: data.selected
			? 'border-primary ring-4 ring-primary/[0.15] shadow-[0_14px_34px_-12px_rgba(37,99,235,0.5)]'
			: 'border-primary/50'} {data.citationRing ? 'ring-[6px] ring-primary/[0.18]' : ''}"
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
			class="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full border border-pri-border bg-accent px-1 text-[11px] font-semibold leading-none text-accent-foreground shadow-sm hover:text-primary"
			aria-label="Expand neighbors"
		>
			+{data.hiddenCount}
		</button>
	{/if}
	<h4 class="text-[15.5px] font-semibold leading-tight {data.retracted ? 'text-muted-foreground line-through' : 'text-card-foreground'}">
		{data.title}
	</h4>
	<p class="mt-0.5 text-xs text-muted-foreground">{data.subtitle}</p>
	<div class="mt-2 flex flex-wrap gap-1">
		{#each data.badges.slice(0, 2) as badge}
			<code class="rounded border border-pri-border bg-accent px-1.5 py-0.5 text-[11px] font-mono text-accent-foreground">{badge}</code>
		{/each}
	</div>
	{#if data.retracted}
		<span class="mt-2 inline-flex items-center rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white">Retracted</span>
	{:else if (data.updateCount ?? 0) > 0}
		<!-- Not a separate button: the whole card already opens the detail
		     drawer (with patch history) on click, so this is just a label. -->
		<div class="mt-2 flex items-center justify-between border-t border-secondary pt-2 text-[11px] text-muted-foreground">
			<span class="flex items-center gap-1"><Clock class="h-3 w-3" /> {data.updateCount} {data.updateCount === 1 ? 'update' : 'updates'}</span>
			<span class="text-primary">View history</span>
		</div>
	{/if}
</div>
