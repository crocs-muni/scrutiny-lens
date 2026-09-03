<script lang="ts">
	/* TRACE TICK — one line of the trace's literal layer (issue #36,
	 * spec §2 rule 6): per-slice receipts and honesty cells, mono,
	 * verbatim. Amber = the honesty cells (a relay couldn't search so we
	 * scanned; a relay truncated) — spec §3/§4. Never AI-written, never
	 * smoothed. */

	import type { TraceTick as Tick } from '$lib/trace';

	interface Props {
		tick: Tick;
		/** Row entry animation (canon's fade-up), styled by the parent so
		 * the stagger offset can vary per row. */
		style?: string;
	}

	let { tick, style }: Props = $props();
</script>

<p
	{style}
	class="font-mono text-[11px] leading-relaxed tabular-nums {tick.warn
		? 'border-l-[1.5px] border-[oklch(0.93_0.05_60)] pl-2 text-[oklch(0.47_0.10_61)]'
		: 'text-ink-3'}"
>
	{tick.text}
</p>
