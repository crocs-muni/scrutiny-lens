<script lang="ts">
	/* RESULTS EMPTY — zero-results state (issue #38, spec §4 "Nothing
	 * matched on your relays" + chips to broaden). When facets narrow to
	 * zero we offer to clear filters; "Ask differently" always appears.
	 * Never suggests demo data — the only honest widening is the relay list
	 * in Settings, which the mono hint points at (spec §4/§9: relay count is
	 * machine-made → mono). */

	interface Props {
		filtered: boolean;
		relayCount: number;
		onClearFilters?(): void;
		onAskDifferently(): void;
	}

	let { filtered, relayCount, onClearFilters, onAskDifferently }: Props = $props();
</script>

<div class="flex w-full justify-center">
	<div class="flex max-w-[420px] flex-col items-center gap-1.5 rounded-[10px] bg-surface p-6 text-center shadow-card">
		<h3 class="font-sans text-[15px] font-semibold text-ink">
			{/* honesty (spec §4): a filtered-out set is the filter's doing,
				not the relays' — never blame the sources */ ''}
			{filtered ? 'Nothing matched your filters' : 'Nothing matched on your relays'}
		</h3>
		<p class="text-[12.5px] leading-relaxed text-ink-2">
			{filtered ? 'Relax the selection to see the rest of the result set.' : 'Try widening your terms, or broaden the facet filters on the left.'}
		</p>

		<div class="mt-2 flex flex-wrap items-center justify-center gap-2">
			{#if filtered && onClearFilters}
				<button
					type="button"
					class="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-surface hover:opacity-90"
					onclick={onClearFilters}
				>
					Clear filters
				</button>
			{/if}
			<button
				type="button"
				class="rounded-full border border-line-strong px-3.5 py-1.5 text-[12px] font-medium text-ink hover:bg-inset"
				onclick={onAskDifferently}
			>
				Ask differently
			</button>
		</div>

		<p class="mt-2 font-mono text-[11px] tabular-nums text-ink-3">
			Searched {relayCount} relays · widen the relay list in Settings (Ctrl+,)
		</p>
	</div>
</div>
