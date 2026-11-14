<script lang="ts">
	/* Test fixture (issue #160): the results rail's keyed each shape —
	 * `visibleCards()` → `{#each … as card (card.id)}` — so the duplicate-key
	 * crash is reproduced by the real derivation + the real key expression,
	 * not by a hand-made list. */
	import type { NostrEvent } from 'nostr-tools/core';
	import { visibleCards } from '$lib/results';
	import type { ProductCard } from '$lib/pipeline/cards';

	interface Props {
		events: NostrEvent[];
		cards: ProductCard[];
	}

	let { events, cards }: Props = $props();
	const visible = $derived(visibleCards(events, {}, cards));
</script>

<ul>
	{#each visible as card (card.id)}
		<li data-testid="rail-card">{card.id}</li>
	{/each}
</ul>
