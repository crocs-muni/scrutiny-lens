<script lang="ts">
	/* TRANSLATE WAIT — the one stage the results rail has nothing to show for
	 * (issue #91, owner ruling 2026-11-16: "waiting block, translate only").
	 *
	 * Why a block and not skeletons: the fetch stage paints real skeleton
	 * cards at the first EOSE, so skeletons here would promise a countable
	 * set before a single relay has answered — and if the query then matched
	 * nothing, the skeletons themselves would have lied. Translate is an
	 * UNKNOWN-DURATION wait (one model round trip; 30–60s cold on the
	 * university endpoint, spec §4's slow-AI row), which is what an
	 * indeterminate indicator plus an elapsed timer is for.
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

	/** Seconds since mount — the block mounts exactly when the translate
	 * stage starts, so the component owns the clock. */
	let seconds = $state(0);
	$effect(() => {
		const t = setInterval(() => (seconds += 1), 1000);
		return () => clearInterval(t);
	});

	const elapsed = $derived(
		seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
	);
	/** One announcement, never a stream of them (#91's a11y finding). The
	 * stage name is the trace's, not a second invention for the same stage. */
	const label = $derived(
		seconds < 30
			? `${phaseLabel('interpret')}…`
			: 'Still translating — a cold endpoint can take up to a minute.'
	);
</script>

<div class="flex w-full items-center gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3">
	<PixelGrid />
	<span role="status" class="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{label}</span>
	<span aria-hidden="true" class="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
		{elapsed}
	</span>
</div>
