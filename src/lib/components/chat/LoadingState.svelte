<script lang="ts">
	/* LOADING STATE (Drive variant) — vendored 2026-09-17 from
	 * aykoooo/beautiful-ui-svelte@main (MIT), itself a Svelte-5 port of
	 * beautiful-ui by Shane Levine (MIT). Attribution preserved per
	 * license; the Surfer/Dots/Orbit gallery variants were dropped on
	 * vendoring — the chat lane needs exactly one honest waiting indicator.
	 *
	 * Pixel-grid chevron loader + shimmering label + live elapsed timer in
	 * mono tabular figures. The keyframes (`pixel-on`, `shimmer-text`) were
	 * vendored alongside into src/app.css. Reduced motion: the global
	 * kill-switch freezes the grid; the timer still ticks.
	 *
	 * The grid itself is shared with the results rail's translate wait
	 * (`PixelGrid.svelte`): one copy of the wavefront timing, so the two
	 * loaders cannot drift apart. */

	import PixelGrid from '../ui/PixelGrid.svelte';

	interface Props {
		/** Shimmering status label. */
		label?: string;
	}

	let { label = 'Thinking' }: Props = $props();

	// Live elapsed timer — deciseconds. Cleanup on destroy.
	let ds = $state(0);
	const elapsed = $derived.by(() => {
		const total = ds / 10;
		return total < 60
			? `${total.toFixed(1)}s`
			: `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
	});

	$effect(() => {
		const t = setInterval(() => (ds += 1), 100);
		return () => clearInterval(t);
	});
</script>

<div role="status" class="flex w-fit flex-col items-start">
	<div class="flex w-fit items-center gap-2.5">
		<PixelGrid />
		<span
			class="bg-clip-text text-[13px] font-medium text-transparent"
			style:background-image="linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)"
			style:background-size="200% 100%"
			style:animation="shimmer-text 1.4s linear infinite"
		>
			{label}
		</span>
		<span class="font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>
	</div>
</div>
