<script lang="ts">
	/* SEARCH HERO — the J1 center stage (design board BIBLE §1 frame J1,
	 * render proof J1-after-render.webp; issue #37, spec §9). Composition
	 * of NoKeyBanner + SearchComposer + SearchSuggestions; all copy is
	 * canned (spec §2 rule 1), §-references are intentional production
	 * copy per the render proof. */

	import SearchComposer from './SearchComposer.svelte';
	import SearchSuggestions from './SearchSuggestions.svelte';
	import NoKeyBanner from './NoKeyBanner.svelte';

	interface Props {
		hasKey: boolean;
		relayCaution?: string;
		onSearch: (question: string) => void;
		onSettings: () => void;
	}

	let { hasKey, relayCaution, onSearch, onSettings }: Props = $props();

	/* Canned prompt pool (spec §2 rule 1 — never AI-written). Shuffle
	 * shows three, excluding repeat rounds. */
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

	let shown = $state<string[]>(pickThree());
</script>

<div class="mx-auto flex w-full max-w-[640px] flex-col justify-center px-16 py-8">
	{#if !hasKey}
		<div class="mb-5">
			<NoKeyBanner {onSettings} />
		</div>
	{/if}
	<p class="text-[14px] text-ink-2">Welcome back</p>
	<h1 class="mt-1 mb-6 text-[27px] font-semibold tracking-[-0.02em]">
		What are you investigating?
	</h1>
	<SearchComposer onSubmit={onSearch} />
	<p class="mt-2 text-[12.5px] text-ink-2">
		Identifiers route <b class="font-semibold">straight to a tag query — never through AI</b>
		(§1). Suggestions below are <b class="font-semibold">canned</b> — AI writes nothing here (§2
		r1); zero-setup first run stays zero-AI.
	</p>
	<div class="mt-5">
		<SearchSuggestions
			suggestions={shown}
			{relayCaution}
			onPick={onSearch}
			onShuffle={() => (shown = pickThree(shown))}
		/>
	</div>
</div>
