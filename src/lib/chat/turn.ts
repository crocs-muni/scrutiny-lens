// Chat turn lifecycle as a closed set of states (ADR 0003, spec §11 step 4).
//
// The store previously spread this across `sending`, `live`, and `error` —
// three fields whose combination the types could not police. The
// combination that mattered: settled AFTER an error. The pump never emits
// it, but nothing forbade it — a transport emitting `error` then `final`
// would persist a turn the user was told failed. The machine makes that
// structurally impossible: once a turn enters `erroring`, `final` is an
// identity and `canPersist` is false. Partial prose after an error stays
// visible (ruling 6) because `erroring` keeps accumulating `raw`.

import type { TurnEvent } from './turn-events';

/** The turn's state. `raw` is the store's live.raw mirror; the store stays the accumulator's single source by copying back after each fold. */
export type Turn =
	| { phase: 'idle' }
	| { phase: 'streaming'; question: string; raw: string }
	| { phase: 'erroring'; question: string; raw: string; message: string };

function unreachable(type: never): never {
	throw new Error(`unreachable turn event: ${String(type)}`);
}

/**
 * One event against one turn. Total: every (state, event) pair has an
 * answer. Illegal pairs are no-ops, not throws, because the events come
 * off a wire we do not control (a duplicate `error`, a stray `delta` after
 * an abort); the store must survive them quietly. `final` never settles —
 * settlement is the store's outcome, granted by `canPersist` on a turn
 * that never errored.
 */
export function transition(turn: Turn, event: TurnEvent): Turn {
	switch (event.type) {
		case 'send':
			return { phase: 'streaming', question: event.question, raw: '' };
		case 'delta':
			if (turn.phase === 'idle') return turn;
			return { ...turn, raw: turn.raw + event.text };
		case 'error':
			if (turn.phase === 'idle') return turn;
			return { ...turn, phase: 'erroring', message: event.message };
		case 'final':
			return turn;
		case 'abort':
			return { phase: 'idle' };
		default:
			return unreachable(event);
	}
}

/**
 * The ADR 0003 edge: only a turn that never errored may persist. The store
 * asks this when a `final` frame arrives.
 */
export function canPersist(turn: Turn): boolean {
	return turn.phase === 'streaming';
}
