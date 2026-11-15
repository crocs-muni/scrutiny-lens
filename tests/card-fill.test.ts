// The card-fill merge seam (src/lib/pipeline/card-fill.ts): computed facts
// always come from the fresh assembly, AI paint only survives from an
// interpreted card, and no live card can vanish.

import { describe, expect, it } from 'vitest';
import { cardFillOf, mergeSettledCards, paintCard } from '../src/lib/pipeline/card-fill';
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

describe('cardFillOf — the live state is read from fields, not guessed', () => {
	it('raw when nothing has painted', () => {
		expect(cardFillOf(card('a'))).toEqual({ kind: 'raw' });
	});
	it('interpreted when the card says so', () => {
		expect(cardFillOf(card('a', { interpreted: true, title: 'AI', snippet: 'S' }))).toEqual({
			kind: 'interpreted',
			title: 'AI',
			snippet: 'S'
		});
	});
});

describe('mergeSettledCards — the settle merge', () => {
	it('a raw live card takes the fresh assembly wholesale (the bug this fixes)', () => {
		const live = card('a', { boundMetadata: 0, files: 0, updates: 0 });
		const fresh = card('a', { boundMetadata: 3, files: 2, updates: 1, title: 'fallback a' });
		expect(mergeSettledCards([live], [fresh])).toEqual([fresh]);
	});

	it('an interpreted live card keeps its paint and gains the fresh counts', () => {
		const live = card('a', { interpreted: true, title: 'AI title', snippet: 'AI snip' });
		const fresh = card('a', { boundMetadata: 3, files: 2, updates: 1 });
		expect(mergeSettledCards([live], [fresh])).toEqual([
			{ ...fresh, title: 'AI title', snippet: 'AI snip', interpreted: true }
		]);
	});

	it('a card the fresh set dropped stays live ("the card I am looking at" wins)', () => {
		const live = card('a', { interpreted: true, title: 'AI' });
		const merged = mergeSettledCards([live], [card('b')]);
		// The dropped card stays in its slot; the arrival appends.
		expect(merged[0]).toBe(live);
		expect(merged.map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('keeps live slot order and appends context arrivals at the end', () => {
		const merged = mergeSettledCards(
			[card('a'), card('b')],
			[card('b'), card('a'), card('c')]
		);
		expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c']);
	});
});

describe('paintCard — a fill pass paints onto the freshest facts', () => {
	it('no live card → the painted card stands as-is', () => {
		const painted = card('a', { interpreted: true, title: 'AI' });
		expect(paintCard(undefined, painted)).toBe(painted);
	});

	it('a raw settle keeps the live card (fresher than the pass snapshot)', () => {
		const live = card('a', { boundMetadata: 2 });
		const snapshot = card('a', { boundMetadata: 0 });
		expect(paintCard(live, snapshot)).toBe(live);
	});

	it('an interpreted settle keeps fresh facts and takes only the paint', () => {
		const live = card('a', { boundMetadata: 2, files: 1, updates: 4 });
		const painted = card('a', {
			boundMetadata: 0,
			interpreted: true,
			title: 'AI title',
			snippet: 'AI snippet'
		});
		expect(paintCard(live, painted)).toMatchObject({
			boundMetadata: 2,
			files: 1,
			updates: 4,
			title: 'AI title',
			snippet: 'AI snippet',
			interpreted: true
		});
	});
});

/** Reproducible PRNG so a failure replays from the printed seed. */
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

describe('mergeSettledCards — invariants over random live/fresh sets', () => {
	it('100 seeds: computed facts come from fresh, paint survives, no live card is lost', () => {
		for (let seed = 1; seed <= 100; seed++) {
			const rnd = mulberry32(seed);
			const ids = ['a', 'b', 'c', 'd', 'e'];
			const live = ids
				.filter(() => rnd() > 0.4)
				.map((id) => card(id, { interpreted: rnd() > 0.5, title: `AI ${id}`, snippet: `S ${id}` }));
			const fresh = ids
				.filter(() => rnd() > 0.4)
				.map((id) => card(id, { boundMetadata: Math.floor(rnd() * 5) }));

			const merged = mergeSettledCards(live, fresh);
			const mergedIds = merged.map((c) => c.id);

			// No duplicate and no lost card, on either side.
			expect(new Set(mergedIds).size).toBe(mergedIds.length);
			for (const card of fresh) expect(mergedIds).toContain(card.id);
			for (const l of live) expect(mergedIds).toContain(l.id);

			for (const card of merged) {
				const f = fresh.find((x) => x.id === card.id);
				if (f === undefined) continue;
				// Computed truth: always the fresh assembly's values.
				expect(card.boundMetadata).toBe(f.boundMetadata);
				expect(card.files).toBe(f.files);
				expect(card.updates).toBe(f.updates);
				expect(card.retracted).toBe(f.retracted);
				// Paint: an interpreted live card keeps its AI text.
				const wasInterpreted = live.find((x) => x.id === card.id)?.interpreted ?? false;
				if (wasInterpreted) {
					expect(card.interpreted).toBe(true);
					expect(card.title).toBe(`AI ${card.id}`);
				}
			}
		}
	});
});
