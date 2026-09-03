<script lang="ts">
	/* SEARCH HERO — the J1 center stage (design board BIBLE §1 frame J1;
	 * issue #37, spec §9). Composition of NoKeyBanner + SearchComposer +
	 * SearchSuggestions; all copy is canned (spec §2 rule 1). The board's
	 * caption line was an engineering annotation (owner ruling 2026-09-03)
	 * and no clamps exist: px-16 padding, content fills the stage. */

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
</script>

<div class="flex h-full w-full flex-col justify-center px-16 py-8">
	{#if !hasKey}
		<div class="mb-5">
			<NoKeyBanner {onSettings} />
		</div>
	{/if}
	<p class="text-[14px] text-ink-2">Welcome back</p>
	<h1 class="mt-1 mb-6 text-[27px] font-semibold tracking-[-0.02em]">
		What are you investigating?
	</h1>
	<SearchComposer onSubmit={onSearch} {onSettings} />
	<div class="mt-6">
		<SearchSuggestions {relayCaution} onPick={onSearch} />
	</div>
</div>
