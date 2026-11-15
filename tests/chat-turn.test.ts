// Transition table for the chat turn machine (src/lib/chat/turn.ts) and the
// ADR 0003 edge it exists to enforce: a turn that errored can never settle.
// The random-sequence property derives the error latch from the EVENT LOG
// (not from the phase it claims to check), so it can actually fail.

import { describe, expect, it } from 'vitest';
import { canPersist, transition, type Turn } from '../src/lib/chat/turn';
import type { TurnEvent } from '../src/lib/chat/turn-events';

const streaming = (raw = ''): Turn => ({ phase: 'streaming', question: 'q', raw });
const erroring = (raw = 'partial', message = 'boom'): Turn => ({
	phase: 'erroring',
	question: 'q',
	raw,
	message
});

describe('transition — the table', () => {
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

	it('a second error replaces the message but keeps the raw', () => {
		const once = transition(streaming('text'), { type: 'error', message: 'first' });
		const twice = transition(once, { type: 'error', message: 'second' });
		expect(twice).toMatchObject({ phase: 'erroring', raw: 'text', message: 'second' });
	});

	it('final is an identity on every phase — the machine never settles', () => {
		for (const state of [{ phase: 'idle' }, streaming('x'), erroring()] as const) {
			expect(transition(state, { type: 'final' })).toBe(state);
		}
	});

	it('abort discards the turn from every phase', () => {
		for (const state of [{ phase: 'idle' }, streaming('x'), erroring()] as const) {
			expect(transition(state, { type: 'abort' })).toEqual({ phase: 'idle' });
		}
	});
});

describe('canPersist — the ADR 0003 edge', () => {
	it('only a turn that never errored may settle', () => {
		expect(canPersist(streaming())).toBe(true);
		expect(canPersist(erroring())).toBe(false);
		expect(canPersist({ phase: 'idle' })).toBe(false);
	});

	it('a turn that errored then received more deltas still cannot settle', () => {
		const walked = transition(
			transition(transition(streaming(), { type: 'error', message: 'x' }), {
				type: 'delta',
				text: 'more'
			}),
			{ type: 'final' }
		);
		expect(canPersist(walked)).toBe(false);
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

describe('transition — property over random event sequences', () => {
	const POOL: TurnEvent[] = [
		{ type: 'send', question: 'q' },
		{ type: 'delta', text: 'a' },
		{ type: 'delta', text: 'b' },
		{ type: 'error', message: 'transport broke' },
		{ type: 'final' },
		{ type: 'abort' }
	];

	it('300 seeds: an error frame makes every later final unpersistable, until the next send/abort', () => {
		// The model's latch is derived from the EVENT LOG only — never from
		// turn.phase — so a machine that stops latching fails this.
		let errorThenFinalSeen = 0;
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = mulberry32(seed);
			let turn: Turn = { phase: 'idle' };
			const log: TurnEvent[] = [];
			for (let i = 0, n = 2 + Math.floor(rnd() * 12); i < n; i++) {
				const event = POOL[Math.floor(rnd() * POOL.length)]!;
				log.push(event);
				turn = transition(turn, event);
				// The next send/abort ends the current turn's history.
				let lastBoundary = -1;
				for (let k = log.length - 1; k >= 0; k--) {
					if (log[k]!.type === 'send' || log[k]!.type === 'abort') {
						lastBoundary = k;
						break;
					}
				}
				const currentTurn = log.slice(lastBoundary + 1);
				const errored = currentTurn.some((e) => e.type === 'error');
				const hadFinalAfterError = currentTurn.some(
					(e, k) =>
						e.type === 'error' &&
						currentTurn.slice(k).some((f) => f.type === 'final')
				);
				if (hadFinalAfterError) errorThenFinalSeen++;
				if (errored) expect(canPersist(turn)).toBe(false);
				else if (turn.phase === 'idle') expect(canPersist(turn)).toBe(false);
			}
		}
		// The walk actually reached the guarded edge — the test is not vacuous.
		expect(errorThenFinalSeen).toBeGreaterThan(0);
	});
});
