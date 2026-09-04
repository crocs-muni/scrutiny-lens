// Results-surface derivation contract (issue #38, spec §3): filtering the
// card set never visibly "un-interprets" a card — AI text is bound to the
// event (eventId, model), not to the current facet selection. And the the
// filtered assembly still dedupes to root products only.

import { describe, expect, it } from 'vitest';
import { filteredEvents, visibleCards } from '$lib/results';
import type { ProductCard } from '$lib/pipeline/cards';

function event(id: string, tags: string[][], content = '') {
	return {
		id,
		pubkey: 'aa'.repeat(32),
		created_at: 1,
		kind: 1,
		tags,
		content,
		sig: '00'.repeat(64)
	};
}

const productA = event('a1'.repeat(32), [
	['t', 'scrutiny-fabric'],
	['t', 'scrutiny-v0.5.9'],
	['t', 'scrutiny-product'],
	['i', 'cve:CVE-2025-1'],
	['i', 'vendor:apple']
]);
const productB = event('b2'.repeat(32), [
	['t', 'scrutiny-fabric'],
	['t', 'scrutiny-v0.5.9'],
	['t', 'scrutiny-product'],
	['i', 'cve:CVE-2025-2']
]);
const ADMITTED = [productA, productB];

const filledA: ProductCard = {
	id: productA.id,
	pubkey: productA.pubkey,
	title: 'AI title for A',
	snippet: 'AI snippet',
	identifiers: ['cve:CVE-2025-1'],
	retracted: false,
	boundMetadata: 0,
	updates: 0,
	contentStart: '',
	interpreted: true
};

describe('visibleCards (spec §3)', () => {
	it('unfiltered: every root product survives with its interpretations', () => {
		const cards = visibleCards(ADMITTED, {}, [filledA]);
		expect(cards).toHaveLength(2);
		const a = cards.find((c) => c.id === productA.id)!;
		expect(a.interpreted).toBe(true);
		expect(a.title).toBe('AI title for A');
	});

	it('filtering narrows to matching products only', () => {
		const cards = visibleCards(ADMITTED, { vendor: new Set(['apple']) }, [filledA]);
		expect(cards).toHaveLength(1);
		expect(cards[0].id).toBe(productA.id);
		expect(cards[0].interpreted).toBe(true);
	});

	it('filtering IN a card keeps its interpretation (no flash to dashed)', () => {
		const unfiltered = visibleCards(ADMITTED, {}, [filledA]);
		const refiltered = visibleCards(ADMITTED, { cve: new Set(['CVE-2025-1']) }, unfiltered);
		expect(refiltered[0].title).toBe('AI title for A');
		expect(refiltered[0].snippet).toBe('AI snippet');
	});

	it('filtering OUT all cards yields an empty set honestly', () => {
		const cards = visibleCards(ADMITTED, { vendor: new Set(['nobody']) }, [filledA]);
		expect(cards).toHaveLength(0);
	});
});

describe('filteredEvents', () => {
	it('counts/events survive for the cohort line and facet rerender', () => {
		expect(filteredEvents(ADMITTED, {})).toHaveLength(2);
		expect(filteredEvents(ADMITTED, { vendor: new Set(['apple']) })).toHaveLength(1);
	});
});
