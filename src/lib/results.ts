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
import { applyFacets, type FacetGroup, type ProductCard } from '$lib/pipeline/cards';

/** Semantic facet axes on top of the i-tag groups (BIBLE J2 rail): these
 * are coded group names, not prefixes — an event i-tag prefix literally
 * named 'type' would collide, accepted given the corpus's corpus vocab. */
export const SEMANTIC_PREFIXES = new Set(['type', 'status', 'interpretation']);

export function semanticGroups(events: NostrEvent[], cards: ProductCard[]): FacetGroup[] {
	const products = events.filter((e) => tTags(e).includes('scrutiny-product')).length;
	const metadata = events.length - products;
	const retracted = cards.filter((c) => c.retracted).length;
	const interpreted = cards.filter((c) => c.interpreted).length;
	return [
		{
			prefix: 'type', // event-space axis (spec §3: counts are event-based)
			values: [
				{ value: 'product', count: products },
				{ value: 'metadata', count: metadata }
			]
		},
		{
			prefix: 'status', // card-space axis
			values: [
				{ value: 'active', count: cards.length - retracted },
				{ value: 'retracted', count: retracted }
			]
		},
		{
			prefix: 'interpretation', // card-space axis
			values: [
				{ value: 'interpreted', count: interpreted },
				{ value: 'not interpreted', count: cards.length - interpreted }
			]
		}
	];
}

/** Apply the semantic selections after the i-tag filter: events narrow by
 * type; cards narrow additionally by status / interpretation (OR within an
 * axis, AND across — same rule as the i-tag groups, spec §3). */
export function afterSemantics(
	events: NostrEvent[],
	cards: ProductCard[],
	selections: Record<string, Set<string>>
): { events: NostrEvent[]; cards: ProductCard[] } {
	const type = selections['type'];
	if (type !== undefined && type.size > 0 && !type.has('product')) cards = [];
	else if (type !== undefined && type.size > 0 && !type.has('metadata'))
		events = events.filter((e) => !tTags(e).includes('scrutiny-metadata'));
	const status = selections['status'];
	if (status !== undefined && status.size === 1) {
		cards = status.has('retracted') ? cards.filter((c) => c.retracted) : cards.filter((c) => !c.retracted);
	}
	const interp = selections['interpretation'];
	if (interp !== undefined && interp.size === 1) {
		cards = interp.has('interpreted') ? cards.filter((c) => c.interpreted) : cards.filter((c) => !c.interpreted);
	}
	return { events, cards };
}

/** Selections minus the semantic axes — the i-tag filter's input. */
export function iTagSelections(selections: Record<string, Set<string>>): Record<string, Set<string>> {
	return Object.fromEntries(Object.entries(selections).filter(([k]) => !SEMANTIC_PREFIXES.has(k)));
}

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
