<script lang="ts">
	import { Clock } from '@lucide/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
		};
	}

	let { data }: Props = $props();
</script>

<div
	class="w-56 rounded-[var(--radius-lg)] border bg-card p-3 shadow-md transition {data.selected
		? 'border-2 border-primary ring-4 ring-primary/[0.15] shadow-[0_14px_34px_-12px_rgba(37,99,235,0.5)]'
		: 'border-border'}"
>
	<h4 class="text-[15.5px] font-semibold leading-tight text-card-foreground">{data.title}</h4>
	<p class="mt-0.5 text-xs text-muted-foreground">{data.subtitle}</p>
	<div class="mt-2 flex flex-wrap gap-1">
		{#each data.badges.slice(0, 2) as badge}
			<code class="rounded border border-pri-border bg-accent px-1.5 py-0.5 text-[11px] font-mono text-accent-foreground">{badge}</code>
		{/each}
	</div>
	<div class="mt-2 flex items-center justify-between border-t border-secondary pt-2 text-[11px] text-muted-foreground">
		<span class="flex items-center gap-1"><Clock class="h-3 w-3" /> 3 updates</span>
		<button class="flex items-center gap-1 hover:text-primary">History</button>
	</div>
</div>
