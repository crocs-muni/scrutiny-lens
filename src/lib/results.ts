// Results-surface derivation (issue #38, spec §3): facet filtering and the
// filtered card set. UI-free like $lib/trace so the honesty rules are
// testable without rendering: facet counts come from the unfiltered set
// (§3) and — crucially — filtering must NEVER visibly "un-interpret" a
// card: the title/snippet an AI wrote for an event belongs to that event
// (eventId, model), not to the current filter. Reassembly would otherwise
// flash interpreted cards back to the rule-5 dashed look for no reason.

import type { NostrEvent } from 'nostr-tools/core';
import { resolveGraph } from '$lib/fabric';
import { applyFacets, assembleCards, type ProductCard } from '$lib/pipeline/cards';

export function filteredEvents(
	events: NostrEvent[],
	selections: Record<string, Set<string>>
): NostrEvent[] {
	return applyFacets(events, selections);
}

export function visibleCards(
	events: NostrEvent[],
	selections: Record<string, Set<string>>,
	/** Previously assembled + AI-filled cards — interpretations merge by id. */
	filled: ProductCard[]
): ProductCard[] {
	const filtered = applyFacets(events, selections);
	const assembled = assembleCards(resolveGraph(filtered), filtered);
	const byId = new Map(filled.map((c) => [c.id, c]));
	return assembled.map((card) => {
		const prior = byId.get(card.id);
		if (prior === undefined || !prior.interpreted) return card;
		return { ...card, title: prior.title, snippet: prior.snippet, interpreted: true };
	});
}
