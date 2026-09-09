<script lang="ts">
	/* TASK TRACE — the trace surface (PR #42): three PhaseRow capsules
	 * derived from the investigation's real pipeline state via $lib/trace.
	 *
	 * Capsules variant of canon TaskRows: each row is its own floating
	 * card (bg-surface shadow-card) — no enclosing card, and no hairline
	 * row rules (canon separates the List rows; Capsules stay uncarded).
	 * The capsule stack replaces the old List card while the fold-to-done
	 * rule is unchanged.
	 *
	 * Fold rule (TR1): after completion the trace collapses to the done
	 * row and stays put — no auto-collapse clock; expanding the detail is
	 * the user's. While running, the row carrying the literal layer
	 * (sources, and decouple once slices exist) opens itself. */

	import { derivePhaseRows, doneLine, type TraceInput } from '$lib/trace';
	import { investigation } from '$lib/investigation.svelte';
	import { settings } from '$lib/settings.svelte';
	import PhaseRow from './PhaseRow.svelte';

	const input = $derived<TraceInput>({
		phase: investigation.phase,
		searches: investigation.searches,
		slices: investigation.slices,
		skeletons: investigation.skeletons,
		notices: investigation.notices,
		relayCount: settings.relays.length,
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
		<!-- List variant per canon TaskRows (owner ruling 2026-09-11): one
			enclosing rounded-card with hairline-separated rows, not capsules. -->
		<div class="self-start overflow-hidden rounded-card bg-surface shadow-card">
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
	{/if}
</div>
