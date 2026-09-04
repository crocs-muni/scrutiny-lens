<script lang="ts">
	/* RESULTS ERROR — all relays dead (issue #38, spec §4): the settled
	 * message plus a per-relay receipt list, verbatim (mono, spec §9). A
	 * relay whose status isn't ok reads orange; the only recovery is Retry
	 * or widening the list via Edit relay list. Never demo data. An empty
	 * receipts array means the run failed before any fetch — one honest
	 * mono line instead (spec §4). */

	interface Props {
		message: string;
		relays: { url: string; status: string }[];
		onRetry(): void;
		onEditRelays(): void;
	}

	let { message, relays, onRetry, onEditRelays }: Props = $props();

</script>

<div class="flex w-full justify-center">
	<div class="flex max-w-[440px] flex-col gap-3 p-2">
		<h3 class="font-sans text-[15px] font-bold text-ink">No relay answered</h3>
		<p class="font-mono text-[12px] text-ink-2">{message}</p>

		<div class="rounded-[10px] border border-line bg-surface p-3">
			{#if relays.length === 0}
				<!-- spec §4: no receipts → the run died before any fetch -->
				<p class="font-mono text-[11.5px] text-ink-3">
					no relay receipts — the run failed before any fetch
				</p>
			{:else}
				<ul class="flex flex-col gap-1.5">
					{#each relays as r (r.url)}
						<li class="flex items-baseline gap-2 font-mono text-[11.5px]">
							<span class="truncate text-ink">{r.url}</span>
							<span class="ml-auto shrink-0 tabular-nums {/^ok$/i.test(r.status) ? 'text-ink-3' : 'text-orange'}">
								{r.status}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="mt-1 flex gap-2">
			<button
				type="button"
				class="rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface hover:opacity-90"
				onclick={onRetry}
			>
				Retry
			</button>
			<button
				type="button"
				class="rounded-full border border-line-strong px-4 py-1.5 text-[12px] font-medium text-ink hover:bg-inset"
				onclick={onEditRelays}
			>
				Edit relay list
			</button>
		</div>
	</div>
</div>
