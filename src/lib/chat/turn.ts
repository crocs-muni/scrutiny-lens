// Chat turn lifecycle as a closed set of states (ADR 0003, spec §11 step 4).
//
// The store previously spread this across `sending`, `live`, and `error` —
// three fields whose combination the types could not police. Two
// combinations matter:
//
// - `error` set while `live` still streams: legal and intended (ruling 6 —
//   partial prose stays visible after a transport failure).
// - settled AFTER an error: the pump never emits it, but nothing in the
//   store forbade it. A buggy or malicious transport emitting `error` then
//   `final` would persist a turn the user was told failed. The machine below
//   makes that transition structurally impossible: once a turn enters
//   `erroring`, no `final` event can settle it.
//
// Aborted turns are silent by ADR 0003 — `abort` from any state discards
// the turn without persisting anything.
//
// This module is pure: the store holds one `Turn` and folds events through
// `transition()`, so the table below is testable without Svelte.

export type Turn =
	| { phase: 'idle' }
	| { phase: 'streaming'; question: string; raw: string }
	| { phase: 'erroring'; question: string; raw: string; message: string };

export type TurnEvent =
	| { type: 'send'; question: string }
	| { type: 'delta'; text: string }
	| { type: 'error'; message: string }
	| { type: 'final' }
	| { type: 'abort' };

function unreachable(type: never): never {
	throw new Error(`unreachable turn event: ${String(type)}`);
}

/**
 * One event against one turn. Total: every (state, event) pair has an
 * answer, and no answer is `settled` — settlement is a STORE outcome (the
 * transcript write), granted only by the caller after `final` returns the
 * turn still streaming. Illegal pairs are no-ops, not throws, because the
 * events come off a wire we do not control (a duplicate `error`, a
 * stray `delta` after an abort); the store must survive them quietly.
 */
export function transition(turn: Turn, event: TurnEvent): Turn {
	switch (event.type) {
		case 'send':
			// A send from a non-idle turn is the caller's bug (the store
			// guards on `sending`); treat it as a fresh start, same as the
			// old code which simply overwrote the fields.
			return { phase: 'streaming', question: event.question, raw: '' };
		case 'delta':
			if (turn.phase === 'idle') return turn;
			return { ...turn, raw: turn.raw + event.text };
		case 'error':
			if (turn.phase === 'idle') return turn;
			return { ...turn, phase: 'erroring', message: event.message };
		case 'final':
			// The one illegal edge the old fields allowed: an error frame
			// latches the turn — a later `final` can never settle it.
			return turn;
		case 'abort':
			return { phase: 'idle' };
		default:
			return unreachable(event);
	}
}

/**
 * Whether the caller should persist a turn on receiving `final`: only a
 * turn still streaming (no error seen) settles. This is the decision the
 * store previously made implicitly by not breaking after an error frame.
 */
export function shouldPersist(turn: Turn, event: TurnEvent): boolean {
	if (event.type !== 'final') return false;
	return turn.phase === 'streaming';
}
