<script lang="ts">
	/* STAGE WAIT — the two stages where the results rail has nothing to show
	 * (issue #91): translate (one model round trip, 30–60s cold) and fetch
	 * before the first slice admits an event. The issue's acceptance names
	 * both: "during the translation window and before the first relay
	 * slice, the working state is unmissable — it occupies the card area".
	 *
	 * Why not skeletons: from the first admitted event on, the rail paints
	 * REAL skeleton cards, so a skeleton here would promise a countable set
	 * before any relay has spoken — and a query that then matches nothing
	 * would have been lied to twice. These stages are UNKNOWN-DURATION
	 * waits, which is what an indeterminate indicator plus an elapsed timer
	 * is for (spec §4's slow-AI row).
	 *
	 * Accessibility: this deliberately does NOT reuse `LoadingState`. That
	 * component's `role="status"` wraps its decisecond timer, so mounting it
	 * for a minute-long wait announces the timer ~10×/s. Here the live
	 * region holds the label only (the trace row's own name for the stage,
	 * plus one honest update at 30s), and the grid and timer are
	 * `aria-hidden`. Reduced motion: the global kill-switch freezes the grid;
	 * the timer still ticks (text survives the floor, animation does not). */

	import PixelGrid from './PixelGrid.svelte';
	import { phaseLabel } from '$lib/trace';

	interface Props {
		/** Which stage the run is in — the label follows the trace's name for
		 * it, so the rail never carries two names for one stage. */
		stage: 'translate' | 'fetch';
	}

	let { stage }: Props = $props();

	/** Measured, not counted: a backgrounded tab throttles timers, so a tick
	 * counter would under-report a 60s wait. `tick` only triggers the
	 * recompute; the value comes from the clock (same reasoning as the run's
	 * own `elapsedMs`). */
	const startedAt = Date.now();
	let tick = $state(0);
	$effect(() => {
		const t = setInterval(() => (tick += 1), 500);
		return () => clearInterval(t);
	});

	const seconds = $derived.by(() => {
		tick;
		return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	});
	const elapsed = $derived(
		seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
	);
	/** One announcement, never a stream of them (#91's a11y finding). */
	const label = $derived(
		seconds < 30
			? `${phaseLabel(stage === 'translate' ? 'interpret' : 'sources')}…`
			: 'Still working — a cold endpoint or a slow relay can take a minute.'
	);
</script>

<div class="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3">
	<PixelGrid />
	<span role="status" class="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{label}</span>
	<span aria-hidden="true" class="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
		{elapsed}
	</span>
</div>
