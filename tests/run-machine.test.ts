import { describe, expect, it } from 'vitest';
import {
	errorOf,
	fillingOf,
	initialRun,
	phaseOf,
	reduce,
	runningOf,
	type RunEvent,
	type RunSnapshot,
	type RunStage
} from '$lib/run-machine';

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

const STAGES: RunStage[] = ['idle', 'translate', 'fetch', 'done'];

describe('run-machine — lifecycle table', () => {
	it('starts idle and projects every field', () => {
		const s = initialRun();
		expect(s.run.status).toBe('idle');
		expect(phaseOf(s)).toBe('idle');
		expect(runningOf(s)).toBe(false);
		expect(errorOf(s)).toBeNull();
		expect(fillingOf(s)).toBe(false);
	});

	it('begin starts a fresh run at the idle stage and clears the fill lane', () => {
		let s = reduce(initialRun(), { type: 'fillArm', cycle: 1 });
		s = reduce(s, { type: 'begin', owner: 2 });
		expect(s.run).toMatchObject({ status: 'running', stage: 'idle', owner: 2 });
		expect(phaseOf(s)).toBe('idle');
		expect(runningOf(s)).toBe(true);
		expect(fillingOf(s)).toBe(false);
	});

	it('advance moves only the current owner', () => {
		const s = reduce(initialRun(), { type: 'begin', owner: 1 });
		const t = reduce(s, { type: 'advance', owner: 1, stage: 'translate' });
		expect(phaseOf(t)).toBe('translate');
		const stale = reduce(t, { type: 'advance', owner: 0, stage: 'fetch' });
		expect(stale).toBe(t);
	});

	it('a failure is painted while running and promoted at settle', () => {
		let s = reduce(initialRun(), { type: 'begin', owner: 1 });
		s = reduce(s, { type: 'advance', owner: 1, stage: 'fetch' });
		s = reduce(s, { type: 'fail', owner: 1, message: 'boom' });
		expect(runningOf(s)).toBe(true); // catch precedes the settle await
		expect(errorOf(s)).toBe('boom');
		const end = reduce(s, { type: 'settle', owner: 1 });
		expect(end.run).toMatchObject({ status: 'failed', stage: 'fetch', message: 'boom' });
		expect(runningOf(end)).toBe(false);
		expect(errorOf(end)).toBe('boom');
	});

	it('a deliberate stop is aborted, not failed', () => {
		let s = reduce(initialRun(), { type: 'begin', owner: 1 });
		s = reduce(s, { type: 'stop', owner: 1 });
		const end = reduce(s, { type: 'settle', owner: 1 });
		expect(end.run.status).toBe('aborted');
		expect(errorOf(end)).toBeNull();
		expect(phaseOf(end)).toBe('idle');
	});

	it('a failure already painted outranks a later stop', () => {
		let s = reduce(initialRun(), { type: 'begin', owner: 1 });
		s = reduce(s, { type: 'fail', owner: 1, message: 'boom' });
		s = reduce(s, { type: 'stop', owner: 1 });
		const end = reduce(s, { type: 'settle', owner: 1 });
		expect(end.run).toMatchObject({ status: 'failed', message: 'boom' });
	});

	it('terminal states absorb advance/settle/fail/stop until a new begin', () => {
		let s = reduce(initialRun(), { type: 'begin', owner: 1 });
		s = reduce(s, { type: 'settleNow', owner: 1 });
		expect(s.run.status).toBe('settled');
		for (const event of [
			{ type: 'advance', owner: 1, stage: 'fetch' },
			{ type: 'settle', owner: 1 },
			{ type: 'fail', owner: 1, message: 'late' },
			{ type: 'stop', owner: 1 }
		] as RunEvent[]) {
			expect(reduce(s, event)).toBe(s);
		}
	});

	it('settleNow promotes a running run at the done stage', () => {
		const s = reduce(reduce(initialRun(), { type: 'begin', owner: 1 }), {
			type: 'settleNow',
			owner: 1
		});
		expect(s.run).toMatchObject({ status: 'settled', stage: 'done' });
	});

	it('the fill lane has one owner and ignores stale drains', () => {
		let s = reduce(initialRun(), { type: 'fillArm', cycle: 1 });
		expect(fillingOf(s)).toBe(true);
		const secondArm = reduce(s, { type: 'fillArm', cycle: 2 });
		expect(secondArm).toBe(s); // first cycle keeps ownership
		const stale = reduce(s, { type: 'fillDrain', cycle: 0 });
		expect(stale).toBe(s);
		const drained = reduce(s, { type: 'fillDrain', cycle: 1 });
		expect(fillingOf(drained)).toBe(false);
	});

	it('reset returns to the initial snapshot regardless of state', () => {
		let s = reduce(initialRun(), { type: 'begin', owner: 1 });
		s = reduce(s, { type: 'fillArm', cycle: 1 });
		s = reduce(s, { type: 'fail', owner: 1, message: 'x' });
		const reset = reduce(s, { type: 'reset' });
		expect(reset).toEqual(initialRun());
	});

	it('a new run abandons the previous fill cycle', () => {
		let s = reduce(initialRun(), { type: 'fillArm', cycle: 1 });
		s = reduce(s, { type: 'begin', owner: 2 });
		expect(fillingOf(s)).toBe(false);
		expect(reduce(s, { type: 'fillDrain', cycle: 1 })).toBe(s);
	});

	it('returns a new top-level snapshot for every effective event', () => {
		const idle = initialRun();
		const begun = reduce(idle, { type: 'begin', owner: 1 });
		const advanced = reduce(begun, { type: 'advance', owner: 1, stage: 'fetch' });
		const failed = reduce(advanced, { type: 'fail', owner: 1, message: 'x' });
		const settled = reduce(failed, { type: 'settle', owner: 1 });
		const armed = reduce(settled, { type: 'fillArm', cycle: 1 });
		// $state.raw only notifies on reassignment: identity reuse would freeze
		// every derived projection while the machine claims it changed.
		for (const next of [begun, advanced, failed, settled, armed]) {
			expect(next).not.toBe(idle);
		}
		expect(new Set([begun, advanced, failed, settled, armed]).size).toBe(5);
	});

	it('does not mutate the input snapshot', () => {
		const s = Object.freeze(reduce(initialRun(), { type: 'begin', owner: 1 }));
		const before = structuredClone(s);
		reduce(s, { type: 'advance', owner: 1, stage: 'fetch' });
		expect(s).toEqual(before);
	});
});

describe('run-machine — 300-seed property fold', () => {
	it('keeps the lifecycle and fill invariants through random events', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = mulberry32(seed);
			let s: RunSnapshot = initialRun();
			let maxOwner = 0;
			let maxCycle = 0;
			for (let step = 0; step < 50; step++) {
				const roll = rnd();
				const owner = Math.floor(rnd() * (maxOwner + 1)); // includes stale 0
				const cycle = Math.floor(rnd() * (maxCycle + 1));
				let event: RunEvent;
				if (roll < 0.25) event = { type: 'begin', owner: ++maxOwner };
				else if (roll < 0.45) event = { type: 'advance', owner, stage: STAGES[Math.floor(rnd() * STAGES.length)] };
				else if (roll < 0.55) event = { type: 'fail', owner, message: `e${seed}.${step}` };
				else if (roll < 0.65) event = { type: 'stop', owner };
				else if (roll < 0.8) event = { type: 'settle', owner };
				else if (roll < 0.9) event = { type: 'fillArm', cycle: ++maxCycle };
				else event = { type: 'fillDrain', cycle };

				s = reduce(s, event);
				const run = s.run;
				// running is exactly the running status; terminals never run.
				expect(runningOf(s)).toBe(run.status === 'running');
				// only a new begin can change the owner.
				if (event.type === 'begin') {
					expect(run.status).toBe('running');
					if (run.status === 'running') expect(run.owner).toBe(event.owner);
				}
				// error is painted only by a failure; settled/aborted stay clean.
				if (run.status === 'settled' || run.status === 'aborted') {
					expect(errorOf(s)).toBeNull();
				}
				if (run.status === 'failed') expect(errorOf(s)).toBe(run.message);
				if (run.status === 'running') expect(errorOf(s)).toBe(run.failure);
				// phase never invents a stage.
				if (run.status !== 'idle') expect(phaseOf(s)).toBe(run.stage);
				// a live fill lane always names its cycle.
				if (s.fill.filling) expect(s.fill.cycle).toBeGreaterThan(0);
			}
		}
	});
});
