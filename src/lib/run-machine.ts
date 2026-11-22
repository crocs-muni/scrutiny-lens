// Pure run lifecycle for the investigation store (issue #212, audit machine #1).
//
// No runes, no I/O, no AbortController: the shell owns transports, settings,
// IndexedDB and the controller. `run` is the lifecycle; `fill` is the parallel
// fill-lane ownership lane, kept separate because a fill cycle may outlive the
// run that started it (openShared's fire-and-forget leg, issue #106/#118).
//
// Failure and abort timing are load-bearing: start()'s catch paints `error`
// before the finally awaits transport.close(), so a failure or stop marks the
// RUNNING state and only `settle` promotes it to a terminal. The projections
// below therefore read `running.failure` too.

import type { Phase } from '$lib/pipeline';

export type RunStage = 'idle' | Phase;

export type RunLifecycle =
	| { status: 'idle' }
	| {
			status: 'running';
			stage: RunStage;
			owner: number;
			failure: string | null;
			stopped: boolean;
		}
	| { status: 'settled'; stage: RunStage; owner: number }
	| { status: 'aborted'; stage: RunStage; owner: number }
	| { status: 'failed'; stage: RunStage; owner: number; message: string };

/** One owner per live fill cycle: a stale drain must not clear a newer lane. */
export type FillLane = { filling: false } | { filling: true; cycle: number };

export interface RunSnapshot {
	run: RunLifecycle;
	fill: FillLane;
}

export type RunEvent =
	| { type: 'begin'; owner: number }
	| { type: 'advance'; owner: number; stage: RunStage }
	| { type: 'fail'; owner: number; message: string }
	| { type: 'stop'; owner: number }
	| { type: 'settle'; owner: number }
	| { type: 'settleNow'; owner: number }
	| { type: 'fillArm'; cycle: number }
	| { type: 'fillDrain'; cycle: number }
	| { type: 'reset' };

export function initialRun(): RunSnapshot {
	return { run: { status: 'idle' }, fill: { filling: false } };
}

/** Total over (snapshot, event): an illegal pair returns the same snapshot. */
export function reduce(snapshot: RunSnapshot, event: RunEvent): RunSnapshot {
	switch (event.type) {
		case 'reset':
			return initialRun();
		case 'begin':
			return {
				run: {
					status: 'running',
					stage: 'idle',
					owner: event.owner,
					failure: null,
					stopped: false
				},
				fill: { filling: false }
			};
		case 'advance': {
			const run = snapshot.run;
			if (run.status !== 'running' || run.owner !== event.owner) return snapshot;
			if (run.stage === event.stage) return snapshot;
			return { ...snapshot, run: { ...run, stage: event.stage } };
		}
		case 'fail': {
			const run = snapshot.run;
			if (run.status !== 'running' || run.owner !== event.owner) return snapshot;
			return { ...snapshot, run: { ...run, failure: event.message } };
		}
		case 'stop': {
			const run = snapshot.run;
			if (run.status !== 'running' || run.owner !== event.owner) return snapshot;
			return { ...snapshot, run: { ...run, stopped: true } };
		}
		case 'settle':
		case 'settleNow': {
			const run = snapshot.run;
			if (run.status !== 'running' || run.owner !== event.owner) return snapshot;
			const stage = event.type === 'settleNow' ? 'done' : run.stage;
			// A real failure outranks a later stop: the error was already painted
			// and must not be erased by an abort that followed it.
			if (run.failure !== null) {
				return {
					...snapshot,
					run: { status: 'failed', stage, owner: run.owner, message: run.failure }
				};
			}
			if (run.stopped) return { ...snapshot, run: { status: 'aborted', stage, owner: run.owner } };
			return { ...snapshot, run: { status: 'settled', stage, owner: run.owner } };
		}
		case 'fillArm':
			if (snapshot.fill.filling) return snapshot;
			return { ...snapshot, fill: { filling: true, cycle: event.cycle } };
		case 'fillDrain':
			if (!snapshot.fill.filling || snapshot.fill.cycle !== event.cycle) return snapshot;
			return { ...snapshot, fill: { filling: false } };
	}
}

/** The store's `phase` projection: terminal states keep their last stage. */
export function phaseOf(snapshot: RunSnapshot): RunStage {
	return snapshot.run.status === 'idle' ? 'idle' : snapshot.run.stage;
}

export function runningOf(snapshot: RunSnapshot): boolean {
	return snapshot.run.status === 'running';
}

/** Painted before the settle await, so a running failure is already visible. */
export function errorOf(snapshot: RunSnapshot): string | null {
	const run = snapshot.run;
	if (run.status === 'failed') return run.message;
	if (run.status === 'running') return run.failure;
	return null;
}

export function fillingOf(snapshot: RunSnapshot): boolean {
	return snapshot.fill.filling;
}
