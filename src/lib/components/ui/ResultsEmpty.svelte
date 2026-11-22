<script lang="ts">
	/* RESULTS EMPTY — zero-results state (issue #38, spec §4 "Nothing
	 * matched on your relays" + chips to broaden). When facets narrow to
	 * zero we offer to clear filters; "Ask differently" always appears.
	 * Never suggests demo data — the only honest widening is the relay list
	 * in Settings, which the mono hint points at (spec §4/§9: relay count is
	 * machine-made → mono). */

	interface Props {
		filtered: boolean;
		/** #164: zero searches were asked — the question carried no term a
		 * relay can match, so this pane must not talk about matches at all. */
		noTerms?: boolean;
		relayCount: number;
		/** ADR 0004: the trusted-publisher view matched nothing. The pane
		 * names what the list is hiding instead of blaming the relays. */
		trusted?: boolean;
		/** Records the run observed outside the trusted list — named so the
		 * empty trusted view never reads as "your relays have nothing". */
		outsideCount?: number;
		onManageTrust?(): void;
		onClearFilters?(): void;
		onAskDifferently(): void;
	}

	let {
		filtered,
		noTerms = false,
		relayCount,
		trusted = false,
		outsideCount = 0,
		onManageTrust,
		onClearFilters,
		onAskDifferently
	}: Props = $props();
</script>

<div class="flex w-full justify-center">
	<div class="flex max-w-[420px] flex-col items-center gap-1.5 rounded-[10px] bg-surface p-6 text-center shadow-card">
		<h3 class="font-sans text-[15px] font-semibold text-ink">
			{/* honesty (spec §4): a filtered-out set is the filter's doing,
				not the relays' — never blame the sources. #164: zero searches
				means nothing was asked, so this is not a match verdict at all. */ ''}
			{noTerms
				? 'Nothing to search for'
				: trusted
					? 'Nothing from your trusted publishers matched'
					: filtered
						? 'Nothing matched your filters'
						: 'Nothing matched on your relays'}
		</h3>
		<p class="text-[12.5px] leading-relaxed text-ink-2">
			{noTerms
				? 'That question has no word a relay can match. Use a product name, an identifier (CVE, cert id, package URL), or a term from the record you mean.'
				: trusted
					? outsideCount === 0
						? 'Nothing outside your trusted publishers matched either. Add a publisher to the list, or ask differently.'
						: `${outsideCount} ${outsideCount === 1 ? 'record' : 'records'} on your relays ${outsideCount === 1 ? 'sits' : 'sit'} outside your trusted publishers. Add a publisher to the list to admit ${outsideCount === 1 ? 'it' : 'them'}, or ask differently.`
					: filtered
						? 'Relax the selection to see the rest of the result set.'
						: 'Try a different spelling or identifier, or add more relays in Settings (Ctrl+,).'}
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
			{#if trusted && !noTerms && onManageTrust}
				<button
					type="button"
					class="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-surface hover:opacity-90"
					onclick={onManageTrust}
				>
					Manage trusted publishers
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
			{/* #131: the count is the run's own recorded pool, so 0 means "not
				recorded" (legacy restored row), never "searched nobody" — state
				the action alone rather than invent a tally (spec §2/§4). */ ''}
			{noTerms
				? 'No query was sent to any relay'
				: relayCount > 0
					? `Searched ${relayCount} relays · widen the relay list in Settings (Ctrl+,)`
					: 'Widen the relay list in Settings (Ctrl+,)'}
		</p>
	</div>
</div>
