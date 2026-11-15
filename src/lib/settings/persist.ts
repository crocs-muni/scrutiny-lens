// Settings persistence as a closed set of states (spec §2 never-lie, §6).
//
// `persistState` was a five-string field any writer could set to any value
// at any time; three laws were enforced only by write-order discipline:
//
// 1. "saved" must mean the write landed (spec §2: a settings UI that claims
//    a save which failed is a lie).
// 2. A write that failed once may be retried exactly once (setRelays' rule)
//    — after that, further failures stay failed.
// 3. `unavailable` is permanent for this tab (private window / blocked
//    storage): no retry may ever flip it back.
//
// The machine makes the laws structural. The store holds one `PersistState`
// and folds events through `transition()`; `saving` carries the retry debt
// so it survives the re-entering save, and only a success clears it.

export type PersistState =
	| { phase: 'idle' }
	| { phase: 'saving'; retried: boolean }
	| { phase: 'saved' }
	| { phase: 'failed'; retried: boolean }
	| { phase: 'unavailable' };

export type PersistEvent =
	| { type: 'save' }
	| { type: 'outcome'; outcome: 'saved' | 'failed' | 'unavailable' };

function unreachable(outcome: never): never {
	throw new Error(`unreachable persistence outcome: ${String(outcome)}`);
}

/**
 * Total over every (state, event) pair:
 *
 * - `unavailable` absorbs everything (terminal for the tab, spec §6).
 * - `save` enters `saving`, carrying the retry debt of the current state.
 * - `outcome: 'saved'` clears the debt; `'failed'` records it; a failure
 *   on a save whose debt is already spent stays failed (one retry only).
 */
export function transition(state: PersistState, event: PersistEvent): PersistState {
	// Outcomes belong to the save that produced them: after a reset() (idle)
	// or an already-settled turn, a late write cannot repaint the phase —
	// an in-flight save resolving after a wipe would otherwise claim
	// "saved" for a tab that just dropped its state.
	if (event.type === 'outcome' && state.phase !== 'saving') return state;
	if (state.phase === 'unavailable') return state;
	// Debt semantics: on `failed` it records "a retry was spent"; entering
	// `saving` from `failed` means THIS attempt is that retry; only a
	// success clears the debt.
	const debt = state.phase === 'failed' ? true : state.phase === 'saving' ? state.retried : false;
	switch (event.type) {
		case 'save':
			return { phase: 'saving', retried: debt };
		case 'outcome':
			switch (event.outcome) {
				case 'saved':
					return { phase: 'saved' };
				case 'unavailable':
					return { phase: 'unavailable' };
				case 'failed':
					return { phase: 'failed', retried: debt };
			}
			return unreachable(event.outcome);
		default:
			return unreachable(event);
	}
}
