<script lang="ts">
	import { Sparkles, Check, Loader2 } from '@lucide/svelte';

	interface Props {
		interpretation: string;
		identifiers?: string[];
		step?: 'recognize' | 'query' | 'traverse';
	}

	let { interpretation = '', identifiers = [], step = 'recognize' }: Props = $props();

	const steps = [
		{ key: 'recognize', label: 'Recognized identifier', icon: Check },
		{ key: 'query', label: 'Queried indexer', icon: Check },
		{ key: 'traverse', label: 'Traversing bindings', icon: Loader2 }
	] as const;
</script>

<div class="w-full rounded-[var(--radius-lg)] border border-pri-border bg-accent p-5">
	<div class="flex items-start gap-3">
		<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
			<Sparkles class="h-5 w-5" />
		</div>
		<div class="min-w-0 flex-1">
			<h3 class="text-[15px] font-semibold text-pri-strong">
				Interpreting your query<span class="inline-flex animate-pulse">...</span>
			</h3>
			<p class="mt-1 text-sm leading-relaxed text-pri-strong">
				{interpretation}
			</p>
			{#if identifiers.length > 0}
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each identifiers as id}
						<code class="rounded bg-pri-mark px-1.5 py-0.5 text-xs font-mono text-pri-deep">{id}</code>
					{/each}
				</div>
			{/if}
			<div class="mt-3 flex items-center gap-4">
				{#each steps as s}
					<div class="flex items-center gap-1.5 text-xs" class:text-muted-foreground={step !== s.key} class:text-pri-strong={step === s.key}>
						<s.icon class="h-3.5 w-3.5 {s.key === 'traverse' && step === s.key ? 'animate-spin' : ''}" />
						{s.label}
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
