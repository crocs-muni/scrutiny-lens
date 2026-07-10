<script lang="ts">
	import { Send, Sparkles } from '@lucide/svelte';

	interface Props {
		questions?: string[];
	}

	let { questions = [] }: Props = $props();
	let input = $state('');
</script>

<div class="flex h-full w-[404px] flex-col border-l border-border bg-surface">
	<div class="border-b border-border bg-card px-4 py-3">
		<h3 class="text-sm font-semibold text-card-foreground">Ask about this graph</h3>
		<p class="text-xs text-muted-foreground">Answers are grounded in the resolved session graph.</p>
	</div>

	<div class="flex-1 overflow-y-auto p-4 space-y-4">
		<div class="flex justify-end">
			<div class="max-w-[86%] rounded-[12px_12px_4px_12px] bg-primary px-3.5 py-2.5 text-[13px] text-primary-foreground">
				What can you tell me about this certification lineage?
			</div>
		</div>
		<div class="flex justify-start">
			<div class="max-w-[88%] rounded-xl border border-border bg-card px-3.5 py-3 text-[13.5px] leading-[1.65] text-foreground/80">
				<div class="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
					<Sparkles class="h-3.5 w-3.5" /> SCRUTINY
				</div>
				This session contains a CVE hub for ROCA (CVE-2017-15361) bound to one product and two metadata documents. Chat wiring will arrive in a later task.
			</div>
		</div>

		{#if questions.length > 0}
			<div class="flex flex-wrap gap-2 pt-2">
				{#each questions as q}
					<button class="rounded-full border border-pri-border bg-accent px-3 py-1.5 text-xs text-accent-foreground hover:bg-pri-tint">{q}</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="border-t border-border p-3">
		<div class="flex items-end gap-2 rounded-[11px] border border-border bg-card p-2">
			<input
				bind:value={input}
				placeholder="Ask a question..."
				class="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
			/>
			<button class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90">
				<Send class="h-4 w-4" />
			</button>
		</div>
	</div>
</div>
