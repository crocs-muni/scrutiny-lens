<script lang="ts">
	/* DOM-test wrapper for GraphCanvas: the toolbar's KeyHint needs the app's
	 * one Tooltip.Provider (routes/+layout.svelte). Props pass straight
	 * through, so the test drives the real component. */
	import { Tooltip } from 'bits-ui';
	import GraphCanvas from '$lib/components/graph/GraphCanvas.svelte';
	import type { NostrEvent } from '$lib/fabric';
	import type { ProductCard } from '$lib/pipeline/cards';

	interface Props {
		events: NostrEvent[];
		cards: ProductCard[];
		root: string | null;
		selectedEventId: string | null;
		onSelect: (id: string) => void;
		onDeselect: () => void;
	}
	let { events, cards, root, selectedEventId, onSelect, onDeselect }: Props = $props();
</script>

<Tooltip.Provider delayDuration={0}>
	<GraphCanvas {events} {cards} {root} {selectedEventId} {onSelect} {onDeselect} />
</Tooltip.Provider>
