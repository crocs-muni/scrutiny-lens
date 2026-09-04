<script lang="ts">
	/* TASK TRACE — the TR1 progress surface (issue #36, spec §2 rule 6).
	 *
	 * VENDORED MUTATION of canon TaskRows
	 * (beautiful-ui-svelte/src/components/TaskRows/TaskRows.svelte):
	 * canon's rows are a scripted demo; here the five rows are derived from
	 * the investigation's real pipeline state via $lib/trace. The card
	 * chrome (rounded-card, shadow-card, border-separated rows, fade-up
	 * entry) is canon's List variant.
	 *
	 * Fold rule (TR1): after completion the trace collapses to the done
	 * row and ALWAYS stays put — no auto-collapse clock; expanding the
	 * detail is the user's. While running, the row carrying the literal
	 * layer (sources) opens itself. */

	import { derivePhaseRows, doneLine, type TraceInput } from '$lib/trace';
	import { investigation } from '$lib/investigation.svelte';
	import { settings } from '$lib/settings.svelte';
	import type { PhaseRow as Row } from '$lib/trace';
	import PhaseRow from './PhaseRow.svelte';

	const input = $derived<TraceInput>({
		phase: investigation.phase,
		searches: investigation.searches,
		slices: investigation.slices,
		skeletons: investigation.skeletons,
		notices: investigation.notices,
		relayCount: settings.relays.length,
		error: investigation.error
	});

	const rows = $derived(derivePhaseRows(input));
	const done = $derived(investigation.phase === 'done' && investigation.error === null);

	/* Expandable rows: default open while their phase runs (the literal
	 * layer is live then), default closed once done; clicks override the
	 * default and the override sticks. */
	let overrides = $state<Record<string, boolean>>({});

	function expanded(row: Row): boolean {
		if (row.ticks.length === 0) return false;
		return overrides[row.id] ?? row.status === 'running';
	}

	function toggle(row: Row): void {
		overrides = { ...overrides, [row.id]: !expanded(row) };
	}

	/* done-settled reopen: the whole trace comes back from the done row. */
	let traceReopened = $state(false);

	const elapsed = $derived(
		investigation.elapsedMs === null ? '' : ` · ${(investigation.elapsedMs / 1000).toFixed(1)}s`
	);
</script>

<div class="flex w-full max-w-[760px] flex-col shrink-0">
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
		<div class="flex w-full flex-col gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card">
			{#each rows as row, i (row.id)}
				<div style:animation={`fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 60}ms both`}>
					<PhaseRow index={i} {row} expanded={expanded(row)} onToggle={() => toggle(row)} />
				</div>
			{/each}
			{#if done}
				<button
					type="button"
					class="border-t border-line px-3 py-2 text-left font-mono text-[11.5px] text-ink-3 hover:text-ink"
					onclick={() => (traceReopened = false)}
				>
					fold trace
				</button>
			{/if}
		</div>
	{/if}
</div>
