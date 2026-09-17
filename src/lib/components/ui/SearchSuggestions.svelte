<script lang="ts">
	/* SEARCH SUGGESTIONS — J1 hero canned prompts (design board BIBLE §1,
	 * issue #37). Canned, never AI (spec §2 rule 1); zero-setup first run
	 * stays zero-AI. Clicking a row runs it like a typed question.
	 *
	 * Rows are a VENDORED MUTATION of canon SearchList
	 * (beautiful-ui-svelte/src/components/SearchList/SearchList.svelte):
	 * the same GlideHighlight row stack + fade-in entry, rescaled to the
	 * board's 36px hero rows. Canon's own copy is demo-dressed (domain
	 * items, its own query state), so the mutation lives here, tier two
	 * of the spec §9 sourcing rule.
	 *
	 * The bottom row carries the shuffle affordance and the relay caution
	 * slot ("relay X lacks search — scans used", spec §3): shown only when
	 * the caller actually knows of a scan-fallback relay — nothing is
	 * invented at rest. */

	import GlideHighlight from 'beautiful-ui-svelte/src/lib/GlideHighlight.svelte';
	import { IconRefresh, IconSearch } from '@tabler/icons-svelte';

	interface Props {
		relayCaution?: string;
		onPick: (question: string, label?: string) => void;
	}

	let { relayCaution, onPick }: Props = $props();

	/* Canned prompt pool (spec §2 rule 1 — never AI-written). Shuffle shows
	 * three, excluding the current round so consecutive sets always differ.
	 *
	 * A row carries a human LABEL and a PROBE: relay full-text (NIP-50)
	 * AND-tokenizes against a word index measured to miss the prose words
	 * ('vulnerability', 'on', 'cards' → 0 hits on every suggestion phrased
	 * as a sentence), so the chip can't run its label like a typed
	 * question — the probe strings are the corpus-verified word sets
	 * ('fastest ECDSA JavaCard'→28, 'ROCA Infineon'→30, 'ML-KEM
	 * CRYSTALS'→29 against the JCAlgTest/sec-certs bootstrap corpus on
	 * lens-demo). The label names the session; the probe proves it. */
	const POOL = [
		{ label: 'PQC algorithms on smart cards (ML-KEM, CRYSTALS)', probe: 'ML-KEM CRYSTALS' },
		{ label: 'Fastest ECDSA on JavaCard ≤ 3.0.5 cards', probe: 'fastest ECDSA JavaCard' },
		{ label: 'ROCA vulnerability in Infineon chips', probe: 'ROCA Infineon' }
	] as const;

	function pickThree(exclude: readonly string[] = []): typeof POOL[number][] {
		// With a pool as small as the row count (3), excluding the shown round
		// would leave shuffle stranded with zero rows — only exclude when a
		// full fresh trio remains.
		const enough = POOL.length - exclude.length >= 3;
		const pool = POOL.filter((s) => !enough || !exclude.includes(s.label));
		const picks: typeof POOL[number][] = [];
		while (picks.length < 3 && pool.length > 0) {
			const i = Math.floor(Math.random() * pool.length);
			picks.push(pool.splice(i, 1)[0]);
		}
		return picks;
	}

	let suggestions = $state<typeof POOL[number][]>(pickThree());

	function onShuffle(): void {
		suggestions = pickThree(suggestions.map((s) => s.label));
	}
</script>

<div class="flex flex-col gap-0.5">
	<GlideHighlight class="flex flex-col gap-0.5" highlightClass="inset-x-0 rounded-control bg-hover">
		{#each suggestions as suggestion (suggestion.label)}
			<button
				data-menu-row
				type="button"
				class="relative z-10 flex min-h-9 w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left text-[14px] text-ink"
				style:animation="fade-in 200ms ease-out both"
				onclick={() => onPick(suggestion.probe, suggestion.label)}
			>
				<IconSearch size={15} stroke={1.9} class="shrink-0 text-ink-2" />
				{suggestion.label}
			</button>
		{/each}
	</GlideHighlight>
	<div class="flex items-center gap-4 px-2 py-1 text-[12.5px] text-ink-2">
		<button
			type="button"
			class="flex items-center gap-1.5 transition-colors duration-150 hover:text-ink"
			onclick={onShuffle}
		>
			<IconRefresh size={14} stroke={2} />
			Shuffle canned suggestions
		</button>
		{#if relayCaution}
			<span class="flex items-center gap-1.5">
				<span class="h-[7px] w-[7px] rounded-full bg-orange"></span>
				{relayCaution}
			</span>
		{/if}
	</div>
</div>
