<script lang="ts">
	import type { SearchCard } from '$lib/ai/types.js';
	import { Network, FileText, Paperclip, Clock } from '@lucide/svelte';

	interface Props {
		card: SearchCard;
		primary?: boolean;
		onOpen?: () => void;
	}

	let { card, primary = false, onOpen }: Props = $props();

	const metaMatch = $derived(card.snippet.match(/^(.*?) · (.*?) · (.*?) · (Active|Archived)/));
	const identifiers = $derived(card.badges.filter((b) => b.includes(':') || b.startsWith('BSI') || b.startsWith('ANSSI')));
	const metaBadges = $derived(card.badges.filter((b) => !identifiers.includes(b)));
</script>

<article class="group flex flex-col rounded-[var(--radius-lg)] border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0 flex-1">
			<h3 class="text-[16.5px] font-semibold tracking-tight text-card-foreground">{card.title}</h3>
			{#if metaMatch}
				<p class="mt-0.5 text-[13px] text-muted-foreground">{metaMatch[1]} · {metaMatch[2]} · {metaMatch[3]}</p>
			{:else}
				<p class="mt-0.5 text-[13px] text-muted-foreground">{metaBadges.slice(0, 3).join(' · ')}</p>
			{/if}
		</div>
		<button
			onclick={onOpen}
			class="shrink-0 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition {primary ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90' : 'border border-primary text-primary hover:bg-accent'}"
		>
			<Network class="h-3.5 w-3.5" />
			Open graph
		</button>
	</div>

	{#if identifiers.length > 0}
		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each identifiers.slice(0, 2) as id}
				<code class="rounded border border-pri-border bg-accent px-1.5 py-0.5 text-xs font-mono text-accent-foreground">{id}</code>
			{/each}
		</div>
	{/if}

	<p class="mt-3 text-[13.5px] leading-[1.55] text-foreground/80">{card.snippet}</p>

	<div class="mt-4 flex items-center justify-between border-t border-secondary pt-3 text-xs text-muted-foreground">
		<div class="flex items-center gap-4">
			<span class="flex items-center gap-1"><FileText class="h-3.5 w-3.5" /> 5 bound metadata</span>
			<span class="flex items-center gap-1"><Paperclip class="h-3.5 w-3.5" /> 2 attachments</span>
			<span class="flex items-center gap-1"><Clock class="h-3.5 w-3.5" /> 3 updates</span>
		</div>
		<span class="font-mono">0.94</span>
	</div>
</article>
