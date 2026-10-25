/**
 * The chat column's polite-region line for a turn transition (#93 W1, #124).
 *
 * Pure so the decision is testable without mounting the column. The rule the
 * bug broke: an aborted turn dies quietly (ADR 0003) — a session switch runs
 * hydrate() → abortInFlight() → messages = [], and the region then spoke the
 * NEW session's not-yet-hydrated count ("0 messages"), which is both noise
 * and a fact about a turn that never happened (spec §2).
 */

export type TurnTransition =
	| { kind: 'started' }
	| { kind: 'failed' }
	/** A turn settled without error: the transcript's real new size. */
	| { kind: 'settled'; messagesAtStart: number; messagesNow: number };

export function chatAnnouncement(transition: TurnTransition): string {
	switch (transition.kind) {
		case 'started':
			return 'Answer streaming';
		case 'failed':
			return 'Answer failed';
		case 'settled':
			// A turn that landed adds messages (a settled answer is ≥2 rows).
			// Not landing — abort on session switch, a reset, a stale hydrate —
			// is not an event worth speaking, and its count is not this turn's.
			return transition.messagesNow > transition.messagesAtStart
				? `${transition.messagesNow} messages`
				: '';
	}
}
