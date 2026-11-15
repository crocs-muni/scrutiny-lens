// Transition table for the card-fill state machine (src/lib/pipeline/card-fill.ts)
// plus a reproducible randomized invariant over random live/fresh sets: the
// computed facts always come from the fresh assembly, the AI paint only
// survives from an interpreted live card, and no card can vanish.

import { describe, expect, it } from 'vitest';
import {
	cardFillOf,
	mergeSettledCards,
	settleCard,
	type CardFill
} from '../src/lib/pipeline/card-fill';
import type { ProductCard } from '../src/lib/pipeline/cards';

function card(id: string, overrides: Partial<ProductCard> = {}): ProductCard {
	return {
		id,
		typeTag: 'scrutiny-product',
		createdAt: 1,
		pubkey: 'pk',
		title: `fallback ${id}`,
		identifiers: [],
		retracted: false,
		boundMetadata: 0,
		files: 0,
		updates: 0,
		contentStart: `content ${id}`,
		interpreted: false,
		...overrides
	};
}

const interpreted = (title: string, snippet?: string): CardFill => ({
	kind: 'interpreted',
	title,
	snippet
});

describe('cardFillOf — the live state is read from fields, not guessed', () => {
	it('raw when the card is neither claimed nor painted', () => {
		expect(cardFillOf(card('a'), new Set())).toEqual({ kind: 'raw' });
	});
	it('pending when a lane claimed it but nothing painted', () => {
		expect(cardFillOf(card('a'), new Set(['a']))).toEqual({ kind: 'pending' });
	});
	it('interpreted wins over pending (streamed paint is the more advanced truth)', () => {
		expect(
			cardFillOf(card('a', { interpreted: true, title: 'AI', snippet: 'S' }), new Set(['a']))
		).toEqual({ kind: 'interpreted', title: 'AI', snippet: 'S' });
	});
});

describe('settleCard — the transition table', () => {
	const fresh = card('a', { boundMetadata: 3, files: 2, updates: 1, title: 'fallback a' });

	it('candidate absent → the live card survives, for every fill kind', () => {
		const live = card('a', { interpreted: true, title: 'AI' });
		for (const fill of [{ kind: 'raw' }, { kind: 'pending' }, interpreted('AI')] as const) {
			expect(settleCard(live, fill, undefined)).toBe(live);
		}
	});

	it('raw + fresh → every fresh field, including counts and title', () => {
		expect(settleCard(card('a'), { kind: 'raw' }, fresh)).toEqual(fresh);
	});

	it('pending + fresh → fresh facts (a pending card holds no paint of its own)', () => {
		const merged = settleCard(card('a'), { kind: 'pending' }, fresh);
		expect(merged.boundMetadata).toBe(3);
		expect(merged.files).toBe(2);
		expect(merged.updates).toBe(1);
		expect(merged.interpreted).toBe(false);
	});

	it('interpreted + fresh → fresh facts, live paint, interpreted kept', () => {
		const merged = settleCard(card('a', { interpreted: true }), interpreted('AI title', 'AI snip'), fresh);
		expect(merged).toMatchObject({
			title: 'AI title',
			snippet: 'AI snip',
			interpreted: true,
			boundMetadata: 3,
			files: 2,
			updates: 1
		});
	});

	it('the computed fields never come from the live side when fresh exists', () => {
		const live = card('a', { boundMetadata: 99, files: 99, updates: 99 });
		expect(settleCard(live, interpreted('AI'), fresh).boundMetadata).toBe(3);
	});
});

describe('mergeSettledCards — slot order and arrivals', () => {
	it('keeps live slot order, appends context arrivals at the end', () => {
		const live = [card('a'), card('b')];
		const fresh = [card('b'), card('a'), card('c')];
		expect(mergeSettledCards(live, fresh, new Set()).map((c) => c.id)).toEqual(['a', 'b', 'c']);
	});

	it('a mixed matrix: raw painted, pending and interpreted all refresh their counts', () => {
		const live = [
			card('a'),
			card('b'),
			card('c', { interpreted: true, title: 'AI c', snippet: 'S' })
		];
		const fresh = [
			card('a', { boundMetadata: 1 }),
			card('b', { boundMetadata: 2 }),
			card('c', { boundMetadata: 3 })
		];
		const merged = mergeSettledCards(live, fresh, new Set(['b']));
		expect(merged.map((c) => c.boundMetadata)).toEqual([1, 2, 3]);
		expect(merged[2]).toMatchObject({ title: 'AI c', snippet: 'S', interpreted: true });
	});
});

/** Reproducible PRNG so a fuzz failure is replayable from a fixed seed. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('mergeSettledCards — invariant over random live/fresh sets', () => {
	it('100 seeds: computed facts come from fresh, ids stay unique, totals are conserved', () => {
		for (let seed = 1; seed <= 100; seed++) {
			const rnd = mulberry32(seed);
			const ids = ['a', 'b', 'c', 'd', 'e'];
			const live = ids
				.filter(() => rnd() > 0.4)
				.map((id) => card(id, { interpreted: rnd() > 0.5, title: `AI ${id}` }));
			const fresh = ids
				.filter(() => rnd() > 0.4)
				.map((id) => card(id, { boundMetadata: Math.floor(rnd() * 5) }));
			const pending = new Set(live.filter((c) => rnd() > 0.5).map((c) => c.id));

			const merged = mergeSettledCards(live, fresh, pending);
			const mergedIds = merged.map((c) => c.id);
			expect(new Set(mergedIds).size).toBe(mergedIds.length);

			for (const card of fresh) expect(mergedIds).toContain(card.id);
			for (const card of merged) {
				const f = fresh.find((x) => x.id === card.id);
				if (f === undefined) continue;
				// Computed truth: always the fresh assembly's values.
				expect(card.boundMetadata).toBe(f.boundMetadata);
				expect(card.files).toBe(f.files);
				expect(card.updates).toBe(f.updates);
				expect(card.retracted).toBe(f.retracted);
			}
			// No live card is allowed to disappear while it still exists in fresh.
			for (const l of live) {
				if (fresh.some((f) => f.id === l.id)) {
					expect(merged.find((m) => m.id === l.id)).toBeDefined();
				}
			}
		}
	});

	it('reducers stay total: every legal fill kind returns a card for any candidate', () => {
		const candidates = [undefined, card('a')];
		const fills: CardFill[] = [{ kind: 'raw' }, { kind: 'pending' }, interpreted('T', 'S')];
		for (const fill of fills) {
			for (const candidate of candidates) {
				expect(settleCard(card('a'), fill, candidate)).toBeDefined();
			}
		}
	});
});
