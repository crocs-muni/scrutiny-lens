<script lang="ts">
	import { FileText, Crosshair, Wrench } from '@lucide/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
			metaType?: 'report' | 'target' | 'maintenance' | 'cve';
		};
	}

	let { data }: Props = $props();

	const Icon = $derived(
		data.metaType === 'cve' ? Crosshair : data.metaType === 'maintenance' ? Wrench : FileText
	);
	const iconColor = $derived(
		data.metaType === 'cve' ? 'text-warning' : data.metaType === 'target' ? 'text-info' : 'text-destructive'
	);
</script>

<div
	class="w-48 rounded-[var(--radius-lg)] border bg-card p-3 shadow-md transition {data.selected
		? 'border-2 border-primary ring-4 ring-primary/[0.15]'
		: 'border-border'}"
>
	<div class="flex items-start gap-2">
		<div class="mt-0.5 shrink-0 {iconColor}">
			<Icon class="h-4 w-4" />
		</div>
		<div class="min-w-0 flex-1">
			<h4 class="text-[13px] font-semibold leading-tight text-card-foreground">{data.title}</h4>
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
</div>
