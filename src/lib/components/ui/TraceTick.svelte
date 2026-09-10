<script lang="ts">
	/* TRACE TICK — one line of the trace's literal layer (issue #36,
	 * spec §2 rule 6): per-slice receipts and honesty cells, verbatim,
	 * never AI-written, never smoothed (spec §3/§4).
	 *
	 * Canon's detail line is "label + mono meta"; our tick model is
	 * single-text ({text, warn?}), so the receipt renders left on the
	 * canon line anatomy and the right meta slot stays implicit. Warn
	 * receipts (a relay couldn't search so we scanned; a relay truncated)
	 * tint the receipt amber via the text-orange token, matching the
	 * app's other warning surfaces (NoticeBanner, ResultsError). */

	import type { TraceTick as Tick } from '$lib/trace';

	interface Props {
		tick: Tick;
		/** Row entry animation (canon's fade-up), styled by the parent so
		 * the stagger offset can vary per row. */
		style?: string;
	}

	let { tick, style }: Props = $props();
</script>

<div {style} class="flex items-center justify-between gap-2">
	<span class="min-w-0 flex-1 text-[12px] text-ink-2 {tick.warn ? 'text-orange' : ''}">
		{tick.text}
	</span>
</div>
