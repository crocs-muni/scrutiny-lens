// Results-surface derivation contract (issue #38, spec §3/§2 rule 2):
// facet filtering changes WHICH cards show, never WHAT a card claims —
// deterministic fields (retracted, update counts) stay sourced from the
// full-set assembly because kind-5 / patch events don't travel on i-tags;
// and filtering must NEVER visibly "un-interpret" a card (AI text is bound
// to eventId+model, not to the current selection).

import { describe, expect, it } from 'vitest';
import { visibleCards } from '$lib/results';
import type { ProductCard } from '$lib/pipeline/cards';

function event(id: string, tags: string[][], content = '') {
	return {
		id,
		pubkey: 'a'.repeat(64),
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

const cardA: ProductCard = {
	id: productA.id,
	pubkey: productA.pubkey,
	title: 'AI title for A',
	snippet: 'AI snippet',
	identifiers: ['cve:CVE-2025-1'],
	retracted: false,
	boundMetadata: 3,
	updates: 1,
	contentStart: '',
	interpreted: true
};
const cardB: ProductCard = {
	id: productB.id,
	pubkey: productB.pubkey,
	title: 'cve:CVE-2025-2',
	snippet: undefined,
	identifiers: ['cve:CVE-2025-2'],
	retracted: true,
	boundMetadata: 0,
	updates: 2,
	contentStart: '',
	interpreted: false
};
const ALL_CARDS = [cardA, cardB];

describe('visibleCards (spec §3)', () => {
	it('unfiltered: every root product survives', () => {
		expect(visibleCards(ADMITTED, {}, ALL_CARDS)).toHaveLength(2);
	});

	it('filtering narrows to products whose event passes AND-across-groups', () => {
		const cards = visibleCards(ADMITTED, { vendor: new Set(['apple']) }, ALL_CARDS);
		expect([...cards.map((c) => c.id)]).toEqual([productA.id]);
	});

	it('protocol truth survives filtering: retracted/updates never recompute on the filtered set (spec §2 rule 2)', () => {
		const cards = visibleCards(ADMITTED, { cve: new Set(['CVE-2025-2']) }, ALL_CARDS);
		expect(cards).toHaveLength(1);
		expect(cards[0].retracted).toBe(true);
		expect(cards[0].updates).toBe(2);
		expect(cards[0].boundMetadata).toBe(0);
	});

	it('filtering IN a card keeps its interpretation (no flash to dashed)', () => {
		const refiltered = visibleCards(ADMITTED, { cve: new Set(['CVE-2025-1']) }, ALL_CARDS);
		expect(refiltered[0].title).toBe('AI title for A');
		expect(refiltered[0].interpreted).toBe(true);
	});

	it('filtering OUT all cards yields an empty set honestly', () => {
		expect(visibleCards(ADMITTED, { vendor: new Set(['nobody']) }, ALL_CARDS)).toHaveLength(0);
	});
});
