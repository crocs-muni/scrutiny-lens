// Results-surface derivation (issue #38, spec §3): facet filtering.
// UI-free like $lib/trace so the honesty rules are testable without
// rendering. Facet counts come from the event set (§3); card VISIBILITY
// comes from which root-product events survive the filter — but every
// deterministic field stays sourced from the FULL-set assembly
// (investigation.cards). Filtering must never recompute protocol truth:
// a retracted pill (NIP-09 e-tags don't carry i-tags) or update count
// (scrutiny-patch e-tags) recomputed over the mutilated set would silently
// flip under a presentation action (spec §2 rule 2, review finding).

import type { NostrEvent } from 'nostr-tools/core';
import { tTags } from '$lib/fabric';
import { applyFacets, type ProductCard } from '$lib/pipeline/cards';

export function visibleCards(
	events: NostrEvent[],
	selections: Record<string, Set<string>>,
	/** Already-assembled full-set cards (deterministic fields + AI fill). */
	cards: ProductCard[]
): ProductCard[] {
	// Root-product events surviving the facet filter (OR within, AND across).
	const visibleProductIds = new Set(
		applyFacets(events, selections)
			.filter((event) => tTags(event).includes('scrutiny-product'))
			.map((event) => event.id)
	);
	return cards.filter((card) => visibleProductIds.has(card.id));
}
