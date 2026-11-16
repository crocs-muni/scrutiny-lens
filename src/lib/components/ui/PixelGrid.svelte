<script lang="ts">
	/* PIXEL GRID — the 3×3 chevron-wavefront loader shared by the two honest
	 * waits (chat's `LoadingState`, the results rail's `TranslateWait`).
	 * One copy of the timing: the wavefront drifted once already when a wait
	 * carried its own delays (bloom.svelte.ts records it), and two loaders
	 * disagreeing on screen reads as a bug. Decorative by contract — the
	 * caller owns the label and must mark it for assistive tech. */

	const DELAYS = Array.from({ length: 9 }, (_, i) => {
		const r = Math.floor(i / 3);
		const c = i % 3;
		return (c + Math.abs(r - 1)) * 90;
	});
	const DUR = 650;
</script>

<span aria-hidden="true" class="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
	{#each DELAYS as delay, index (index)}
		<span
			class="size-[4px] rounded-[1px] bg-ink"
			style:opacity="0.15"
			style:animation={`pixel-on ${DUR}ms ease-in-out ${delay}ms infinite`}
		></span>
	{/each}
</span>
