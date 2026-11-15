// Transition table for the chat turn machine (src/lib/chat/turn.ts).
// The table is exhaustive over (state × event); illegal pairs must be
// no-ops, `final` after an error must never permit persistence (ADR 0003),
// and random event sequences must never reach a state that could settle a
// failed turn.

import { describe, expect, it } from 'vitest';
import { shouldPersist, transition, type Turn, type TurnEvent } from '../src/lib/chat/turn';

const streaming = (raw = ''): Turn => ({ phase: 'streaming', question: 'q', raw });
const erroring = (raw = 'partial', message = 'boom'): Turn => ({
	phase: 'erroring',
	question: 'q',
	raw,
	message
});

const EVENTS: TurnEvent[] = [
	{ type: 'send', question: 'q2' },
	{ type: 'delta', text: 'x' },
	{ type: 'error', message: 'e' },
	{ type: 'final' },
	{ type: 'abort' }
];

const STATES: Turn[] = [{ phase: 'idle' }, streaming('hello'), erroring()];

describe('transition — the full table', () => {
	it('every (state, event) pair is total and returns a Turn', () => {
		for (const state of STATES) {
			for (const event of EVENTS) {
				expect(transition(state, event)).toBeDefined();
			}
		}
	});

	it('send starts streaming with empty raw', () => {
		expect(transition({ phase: 'idle' }, { type: 'send', question: 'q' })).toEqual({
			phase: 'streaming',
			question: 'q',
			raw: ''
		});
	});

	it('delta appends while streaming and while erroring (partial prose keeps arriving)', () => {
		expect(transition(streaming('a'), { type: 'delta', text: 'b' })).toEqual(streaming('ab'));
		expect(transition(erroring('a'), { type: 'delta', text: 'b' })).toMatchObject({
			phase: 'erroring',
			raw: 'ab',
			message: 'boom'
		});
	});

	it('delta and error are no-ops from idle (no turn exists)', () => {
		expect(transition({ phase: 'idle' }, { type: 'delta', text: 'x' })).toEqual({ phase: 'idle' });
		expect(transition({ phase: 'idle' }, { type: 'error', message: 'x' })).toEqual({
			phase: 'idle'
		});
	});

	it('error latches: raw survives, phase flips', () => {
		expect(transition(streaming('partial'), { type: 'error', message: '503' })).toEqual({
			phase: 'erroring',
			question: 'q',
			raw: 'partial',
			message: '503'
		});
	});

	it('abort discards the turn from every phase', () => {
		for (const state of STATES) {
			expect(transition(state, { type: 'abort' })).toEqual({ phase: 'idle' });
		}
	});

	it('a second error replaces the message but keeps the raw', () => {
		const once = transition(streaming('text'), { type: 'error', message: 'first' });
		const twice = transition(once, { type: 'error', message: 'second' });
		expect(twice).toMatchObject({ phase: 'erroring', raw: 'text', message: 'second' });
	});
});

describe('shouldPersist — the ADR 0003 edge', () => {
	it('final persists only a turn that never errored', () => {
		expect(shouldPersist(streaming(), { type: 'final' })).toBe(true);
		expect(shouldPersist(erroring(), { type: 'final' })).toBe(false);
		expect(shouldPersist({ phase: 'idle' }, { type: 'final' })).toBe(false);
	});

	it('no other event ever settles a turn', () => {
		for (const state of STATES) {
			for (const event of EVENTS.filter((e) => e.type !== 'final')) {
				expect(shouldPersist(state, event)).toBe(false);
			}
		}
	});
});

/** Reproducible PRNG so a failure replays from the seed printed in the error. */
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
	it('300 seeds: no sequence reaches an erroring turn that a final could settle', () => {
		const pool: TurnEvent[] = [
			{ type: 'send', question: 'q' },
			{ type: 'delta', text: 'a' },
			{ type: 'delta', text: 'b' },
			{ type: 'error', message: 'transport broke' },
			{ type: 'final' },
			{ type: 'abort' }
		];
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = mulberry32(seed);
			let turn: Turn = { phase: 'idle' };
			let sawError = false;
			const steps = 2 + Math.floor(rnd() * 12);
			for (let i = 0; i < steps; i++) {
				const event = pool[Math.floor(rnd() * pool.length)]!;
				turn = transition(turn, event);
				// The latch is per-turn: only a send (a brand-new turn) or
				// an abort (no turn) may clear it.
				if (event.type === 'send' || event.type === 'abort') sawError = false;
				if (turn.phase === 'erroring') sawError = true;
				if (turn.phase === 'idle') sawError = false;
				// The invariant: an error seen within this turn makes every
				// later final unpersistable.
				if (sawError) expect(shouldPersist(turn, { type: 'final' })).toBe(false);
			}
		}
	});
	it('300 seeds: abort always returns to idle and stays persistable after a fresh send', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = mulberry32(seed);
			let turn: Turn = transition({ phase: 'idle' }, { type: 'send', question: 'q' });
			for (let i = 0; i < 8; i++) {
				const kind = rnd();
				if (kind < 0.3) turn = transition(turn, { type: 'delta', text: 'x' });
				else if (kind < 0.5) turn = transition(turn, { type: 'error', message: 'x' });
				else if (kind < 0.7) turn = transition(turn, { type: 'abort' });
				else if (kind < 0.85) turn = transition(turn, { type: 'final' });
				else turn = transition(turn, { type: 'send', question: 'q' });
			}
			// Whatever the walk did, a final abort lands idle...
			expect(transition(turn, { type: 'abort' })).toEqual({ phase: 'idle' });
			// ...and a fresh send is always streamable.
			const fresh = transition(turn, { type: 'send', question: 'next' });
			expect(fresh.phase).toBe('streaming');
			expect(shouldPersist(fresh, { type: 'final' })).toBe(true);
		}
	});
});
