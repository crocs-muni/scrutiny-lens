<script lang="ts">
	/* SEARCH SUGGESTIONS — J1 hero canned prompts (design board BIBLE §1,
	 * issue #37). Canned, never AI (spec §2 rule 1); zero-setup first run
	 * stays zero-AI. Clicking a row runs it like a typed question.
	 *
	 * The bottom row carries the shuffle affordance and the relay caution
	 * slot ("relay X lacks search — scans used", spec §3): shown only when
	 * the caller actually knows of a scan-fallback relay — nothing is
	 * invented at rest. */

	import { IconRefresh, IconSearch } from '@tabler/icons-svelte';

	interface Props {
		relayCaution?: string;
		onPick: (question: string) => void;
	}

	let { relayCaution, onPick }: Props = $props();

	/* Canned prompt pool (spec §2 rule 1 — never AI-written). Shuffle shows
	 * three, excluding the current round so consecutive sets always differ.
	 * The pool lives here, next to its only consumer (review, Standards). */
	const POOL = [
		'ROCA vulnerability in Infineon chips',
		'FIPS 140-3 certificates expiring this year',
		'Which packages still bundle OpenSSL 3.0?',
		'Common Criteria EAL4+ certificates from BSI',
		'JCAlgTest results for NXP JCOP cards',
		'TPM firmware vulnerabilities with CVE records',
		'Certificates covering Java Card 3.1 platforms',
		'Infineon smartcards with maintained certifications'
	] as const;

	function pickThree(exclude: readonly string[] = []): string[] {
		const pool = POOL.filter((s) => !exclude.includes(s));
		const picks: string[] = [];
		while (picks.length < 3 && pool.length > 0) {
			const i = Math.floor(Math.random() * pool.length);
			picks.push(pool.splice(i, 1)[0]);
		}
		return picks;
	}

	let suggestions = $state<string[]>(pickThree());

	function onShuffle(): void {
		suggestions = pickThree(suggestions);
	}
</script>

<div class="flex flex-col gap-0.5">
	{#each suggestions as suggestion (suggestion)}
		<button
			type="button"
			class="flex min-h-9 items-center gap-2.5 rounded-control px-2 py-1.5 text-left text-[14px] text-ink hover:bg-hover"
			onclick={() => onPick(suggestion)}
		>
			<IconSearch size={15} stroke={1.9} class="shrink-0 text-ink-2" />
			{suggestion}
		</button>
	{/each}
	<div class="flex items-center gap-4 px-2 py-1 text-[12.5px] text-ink-2">
		<button
			type="button"
			class="flex items-center gap-1.5 hover:text-ink"
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
