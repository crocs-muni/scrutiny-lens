<script lang="ts">
	import { GitCommitVertical } from '@lucide/svelte';

	interface Props {
		data: {
			title: string;
			subtitle: string;
			badges: string[];
			selected?: boolean;
			retracted?: boolean;
		};
	}

	let { data }: Props = $props();
</script>

<div
	class="w-44 rounded-[var(--radius-lg)] border p-3 shadow-md transition {data.retracted
		? 'border-2 border-dashed border-destructive bg-[repeating-linear-gradient(135deg,#fff,#fff_8px,#fafafa_8px,#fafafa_16px)]'
		: data.selected
			? 'border-2 border-primary bg-card ring-4 ring-primary/[0.15]'
			: 'border-border bg-card'}"
>
	<div class="flex items-center gap-2">
		<GitCommitVertical class="h-4 w-4 {data.retracted ? 'text-destructive' : 'text-warning'}" />
		<h4 class="text-[13px] font-semibold {data.retracted ? 'text-muted-foreground line-through' : 'text-card-foreground'}">{data.title}</h4>
	</div>
	<p class="mt-1 text-[11px] text-muted-foreground">{data.subtitle}</p>
	{#if data.retracted}
		<span class="mt-2 inline-flex items-center rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white">Retracted</span>
	{/if}
</div>
