<script lang="ts">
	import { FileText, Crosshair, Wrench } from '@lucide/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
			metaType?: 'report' | 'target' | 'maintenance';
			retracted?: boolean;
		};
	}

	let { data }: Props = $props();

	const Icon = $derived(data.metaType === 'maintenance' ? Wrench : data.metaType === 'target' ? Crosshair : FileText);
	const iconColor = $derived(data.metaType === 'target' ? 'text-info' : 'text-destructive');
</script>

<div
	class="w-48 rounded-[var(--radius-lg)] border p-3 shadow-md transition {data.retracted
		? 'border-2 border-dashed border-destructive bg-[repeating-linear-gradient(135deg,#fff,#fff_8px,#fafafa_8px,#fafafa_16px)]'
		: data.selected
			? 'border-2 border-primary bg-card ring-4 ring-primary/[0.15]'
			: 'border-border bg-card'}"
>
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
