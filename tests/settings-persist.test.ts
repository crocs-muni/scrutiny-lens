// Transition table for the settings-persistence machine
// (src/lib/settings/persist.ts). The three laws it encodes: "saved" means
// the write landed (spec §2), a write retries at most once, and
// `unavailable` is terminal for the tab (spec §6 no-retry).

import { describe, expect, it } from 'vitest';
import { transition, type PersistEvent, type PersistState } from '../src/lib/settings/persist';

const EVENTS: PersistEvent[] = [
	{ type: 'save' },
	{ type: 'outcome', outcome: 'saved' },
	{ type: 'outcome', outcome: 'failed' },
	{ type: 'outcome', outcome: 'unavailable' }
];

const STATES: PersistState[] = [
	{ phase: 'idle' },
	{ phase: 'saving', retried: false },
	{ phase: 'saving', retried: true },
	{ phase: 'saved' },
	{ phase: 'failed', retried: false },
	{ phase: 'failed', retried: true },
	{ phase: 'unavailable' }
];

describe('transition — the full table', () => {
	it('the full table: every (state, event) pair lands where the laws say', () => {
		// Rows are the exact expected next state for each pairing; anything
		// that drifts from this table is a behaviour change.
		const S = (phase: 'idle'): PersistState => ({ phase });
		const sav = (retried: boolean): PersistState => ({ phase: 'saving', retried });
		const fl = (retried: boolean): PersistState => ({ phase: 'failed', retried });
		const table: [PersistState, PersistEvent, PersistState][] = [
			[S('idle'), { type: 'save' }, sav(false)],
			[S('idle'), { type: 'outcome', outcome: 'saved' }, S('idle')],
			[S('idle'), { type: 'outcome', outcome: 'failed' }, S('idle')],
			[S('idle'), { type: 'outcome', outcome: 'unavailable' }, S('idle')],
			[sav(false), { type: 'save' }, sav(false)],
			[sav(false), { type: 'outcome', outcome: 'saved' }, { phase: 'saved' }],
			[sav(false), { type: 'outcome', outcome: 'failed' }, fl(false)],
			[sav(false), { type: 'outcome', outcome: 'unavailable' }, { phase: 'unavailable' }],
			[sav(true), { type: 'save' }, sav(true)],
			[sav(true), { type: 'outcome', outcome: 'saved' }, { phase: 'saved' }],
			[sav(true), { type: 'outcome', outcome: 'failed' }, fl(true)],
			[sav(true), { type: 'outcome', outcome: 'unavailable' }, { phase: 'unavailable' }],
			[{ phase: 'saved' }, { type: 'save' }, sav(false)],
			[{ phase: 'saved' }, { type: 'outcome', outcome: 'saved' }, { phase: 'saved' }],
			[{ phase: 'saved' }, { type: 'outcome', outcome: 'failed' }, { phase: 'saved' }],
			[{ phase: 'saved' }, { type: 'outcome', outcome: 'unavailable' }, { phase: 'saved' }],
			[fl(false), { type: 'save' }, sav(true)],
			[fl(false), { type: 'outcome', outcome: 'saved' }, fl(false)],
			[fl(false), { type: 'outcome', outcome: 'failed' }, fl(false)],
			[fl(false), { type: 'outcome', outcome: 'unavailable' }, fl(false)],
			[fl(true), { type: 'save' }, sav(true)],
			[fl(true), { type: 'outcome', outcome: 'saved' }, fl(true)],
			[fl(true), { type: 'outcome', outcome: 'failed' }, fl(true)],
			[fl(true), { type: 'outcome', outcome: 'unavailable' }, fl(true)],
			[{ phase: 'unavailable' }, { type: 'save' }, { phase: 'unavailable' }],
			[{ phase: 'unavailable' }, { type: 'outcome', outcome: 'saved' }, { phase: 'unavailable' }],
			[{ phase: 'unavailable' }, { type: 'outcome', outcome: 'failed' }, { phase: 'unavailable' }],
			[{ phase: 'unavailable' }, { type: 'outcome', outcome: 'unavailable' }, { phase: 'unavailable' }]
		];
		for (const [state, event, expected] of table) {
			expect(transition(state, event)).toEqual(expected);
		}
		// The table is exhaustive: 7 states × 4 events.
		expect(table).toHaveLength(STATES.length * EVENTS.length);
	});

	it('save enters saving, carrying the retry debt of the current state', () => {
		expect(transition({ phase: 'idle' }, { type: 'save' })).toEqual({ phase: 'saving', retried: false });
		expect(transition({ phase: 'failed', retried: true }, { type: 'save' })).toEqual({
			phase: 'saving',
			retried: true
		});
		expect(transition({ phase: 'saved' }, { type: 'save' })).toEqual({ phase: 'saving', retried: false });
	});

	it('unavailable ignores save — storage is gone for the tab', () => {
		expect(transition({ phase: 'unavailable' }, { type: 'save' })).toEqual({
			phase: 'unavailable'
		});
	});

	it('outcome saved/failed/unavailable lands as told', () => {
		expect(transition({ phase: 'saving', retried: false }, { type: 'outcome', outcome: 'saved' })).toEqual({
			phase: 'saved'
		});
		expect(
			transition({ phase: 'saving', retried: false }, { type: 'outcome', outcome: 'unavailable' })
		).toEqual({ phase: 'unavailable' });
	});

	it('one retry only: a failure after a spent retry stays failed', () => {
		const first = transition({ phase: 'saving', retried: false }, { type: 'outcome', outcome: 'failed' });
		expect(first).toEqual({ phase: 'failed', retried: false });
		// The retry is spent by the re-save...
		const again = transition(first, { type: 'save' });
		expect(again).toEqual({ phase: 'saving', retried: true });
		// ...so this failure is terminal, and so is every later one.
		const second = transition(again, { type: 'outcome', outcome: 'failed' });
		expect(second).toEqual({ phase: 'failed', retried: true });
		const third = transition(
			transition(second, { type: 'save' }),
			{ type: 'outcome', outcome: 'failed' }
		);
		expect(third).toEqual({ phase: 'failed', retried: true });
	});

	it('a success clears the retry debt', () => {
		const failed = transition({ phase: 'saving', retried: true }, { type: 'outcome', outcome: 'failed' });
		const recovered = transition(failed, { type: 'save' });
		expect(transition(recovered, { type: 'outcome', outcome: 'saved' })).toEqual({
			phase: 'saved'
		});
		expect(transition({ phase: 'saved' }, { type: 'save' })).toEqual({ phase: 'saving', retried: false });
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

describe('transition — invariants over random event sequences', () => {
	it('300 seeds: unavailable never recovers; saved never follows a save event', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = mulberry32(seed);
			let state: PersistState = { phase: 'idle' };
			let sawUnavailable = false;
			for (let i = 0; i < 24; i++) {
				const event: PersistEvent =
					rnd() < 0.45
						? { type: 'save' }
						: {
								type: 'outcome',
								outcome: rnd() < 0.6 ? 'saved' : rnd() < 0.8 ? 'failed' : 'unavailable'
							};
				state = transition(state, event);
				if (state.phase === 'unavailable') sawUnavailable = true;
				// Law: terminal for the tab.
				if (sawUnavailable) expect(state.phase).toBe('unavailable');
				// Law: only a saved outcome can produce `saved`.
				if (event.type === 'save') expect(state.phase).not.toBe('saved');
			}
		}
	});
});
