<script lang="ts">
	/* TASK TRACE — the trace surface (PR #42): three PhaseRow capsules
	 * derived from the investigation's real pipeline state via $lib/trace.
	 *
	 * List variant of canon TaskRows (visual ruling 2026-09-11): one
	 * enclosing rounded card holds hairline-separated rows; the done-fold
	 * swaps this list for a single done row.
	 *
	 * Fold rule (TR1): after completion the trace collapses to the done
	 * row and stays put — no auto-collapse clock; expanding the detail is
	 * the user's. While running, the row carrying the literal layer
	 * (sources, and decouple once slices exist) opens itself. */

	import { slide } from 'svelte/transition';
	import { derivePhaseRows, doneLine, type TraceInput } from '$lib/trace';
	import { aggregatePerRelay } from '$lib/relay-readout';
	import { investigation } from '$lib/investigation.svelte';
	import PhaseRow from './PhaseRow.svelte';

	/* Run provenance (issue #131): the trace describes THIS run, so every
	 * counter it prints comes from run-scoped state — the frozen pool, never
	 * the live Settings list (editing Settings mid-run rewrote the past).
	 * A done run with no searches is a share cold-open (openShared never
	 * asked a question); `restoredEvicted` is non-null exactly on a restored
	 * surface, which is never a cold-open even with zero searches. Both
	 * reset with the run. Restore needs no third arm: its counter reads the
	 * all-cache slices (issue #83), so 'search' is the honest default there. */
	const runKind = $derived<'search' | 'share'>(
		investigation.restoredEvicted === null &&
			investigation.phase === 'done' &&
			investigation.searches.length === 0
			? 'share'
			: 'search'
	);

	const input = $derived<TraceInput>({
		phase: investigation.phase,
		searches: investigation.searches,
		slices: investigation.slices,
		skeletons: investigation.skeletons,
		notices: investigation.notices,
		relayCount: investigation.runRelays.length,
		runKind,
		/* Folded per RELAY (#131/#132): the literal layer names one source
		 * once, however many legs asked it. Shared opens and restores have no
		 * live slices of their own — their receipts are the RECORDED ones the
		 * run carried (openShared passes the resolver's fold; restore reads
		 * the run row), so the literal layer still names every relay asked,
		 * never a fabricated empty set. */
		relayLines:
			investigation.recordedRelayReceipts.length > 0
				? investigation.recordedRelayReceipts
				: aggregatePerRelay(investigation.slices),
		error: investigation.error,
		descriptions:
			investigation.filling || (investigation.result !== null && investigation.fillStats.total > 0)
				? { running: investigation.filling, ...investigation.fillStats }
				: undefined
	});

	const rows = $derived(derivePhaseRows(input));
	const done = $derived(investigation.phase === 'done' && investigation.error === null);

	/* done-settled reopen: the whole trace comes back from the done row. */
	let traceReopened = $state(false);

	const elapsed = $derived(
		investigation.elapsedMs === null ? '' : ` · ${(investigation.elapsedMs / 1000).toFixed(1)}s`
	);

	/* Failed-row retry (spec §1.3): re-fire the question that just failed —
	 * the trace rows are derived state, so a single start() recycling the
	 * pipeline state is all the retry needs. */
	const retry = (): void => {
		void investigation.start(investigation.lastQuestion);
	};
</script>

<div class="flex w-full max-w-[760px] shrink-0 flex-col gap-2">
	{#if done && !traceReopened}
		<!-- done row (TR1): folded forever until the user expands — never
			auto-collapses on a clock. -->
		<button
			type="button"
			class="flex w-full items-center gap-2.5 rounded-card bg-surface px-3 py-2.5 text-left shadow-card"
			onclick={() => (traceReopened = true)}
			aria-expanded="false"
		>
			<span class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-green text-white">
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M20 6L9 17l-5-5" />
				</svg>
			</span>
			<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
				{doneLine(input)}{elapsed}
			</span>
			<span class="font-mono text-[11.5px] text-ink-3">expand trace</span>
		</button>
	{:else}
		<!-- slide on the branch root gives the fold its outro — the two
			branches are separate DOM so without a transition the swap is
			instant (owner report 2026-09-11) -->
		<div
			class="flex flex-col gap-2"
			transition:slide={{ duration: 200, easing: (t) => 1 - (1 - t) ** 3 }}
		>
		<!-- List variant per canon TaskRows (owner ruling 2026-09-11): one
			enclosing rounded-card with hairline-separated rows, not capsules. -->
		<!-- canon List chrome; full column width (canon's self-start only
			serves its own fixed-width capsule column) -->
		<div class="overflow-hidden rounded-card bg-surface shadow-card">
			{#each rows as row, i (row.id)}
				<PhaseRow
					number={i + 1}
					status={row.status}
					label={row.label}
					amount={row.counter}
					ticks={row.ticks}
					progress={row.progress}
					onRetry={row.status === 'failed' ? retry : undefined}
				/>
			{/each}
		</div>
		{#if done}
			<button
				type="button"
				class="self-start px-2.5 py-1 font-mono text-[11.5px] text-ink-3 hover:text-ink"
				onclick={() => (traceReopened = false)}
			>
				fold trace
			</button>
		{/if}
		</div>
	{/if}
</div>
