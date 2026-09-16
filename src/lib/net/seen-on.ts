/**
 * Per-event seen-on relay registry (issue #31, spec §8).
 *
 * WHY this exists: the share link's nevent carries up to 3 "I saw this
 * event here" relay hints so a cold-open knows where to look first, and
 * the cold-open tells the recipient which of those hinted relays failed
 * (spec §4). The hints must reflect where the event was ACTUALLY observed
 * by this client — not the relay config — so the transport records each
 * relay that returns an event as a seen-on hit (transport.ts fetchRouted).
 *
 * Ordering contract: insertion order, first observed wins. A re-observation
 * on an already-recorded relay never promotes it — hints stay stable so the
 * encoded share link doesn't churn between shares of the same event.
 * Capacity: capped at 4 (hard IDB write cap; encode slices to ≤3 so the
 * recipient keeps one spare hint even if a hinted relay is gone).
 */
import { getRelayHints, putRelayHints } from '$lib/db';

/** Max hints kept per event; must stay ≥ buildShareLinks' ≤3 slice. */
export const SEEN_ON_CAP = 4;

/** Per-event serialization for the fire-and-forget writes. */
const pending = new Map<string, Promise<void>>();

/**
 * Records that `relayUrl` returned `eventId`, first-observed-wins in
 * insertion order. Fire-and-forget: reads the current hints, appends the
 * unseen url, trims past SEEN_ON_CAP, writes back. Never throws — the db
 * layer's attempt() already degrades to memory-only (spec §6); the write
 * is async so transport ingest is never slowed by a race with IDB.
 *
 * WHY the per-event chain: recordSeenOn is called concurrently from the
 * per-relay legs of fetchRouted, and an un-serialized read-modify-write
 * loses every hint but the last (same loss class as saveInterpretation,
 * review T-1). Chaining each op on the event's previous op makes the
 * read see the previous write; the map slot is released once drained.
 */
export function recordSeenOn(eventId: string, relayUrl: string): void {
	const prev = pending.get(eventId) ?? Promise.resolve();
	const op = prev.then(async () => {
		const hints = (await getRelayHints(eventId))?.relays ?? [];
		if (hints.includes(relayUrl)) return; // re-observation: already recorded
		const merged = [...hints, relayUrl].slice(0, SEEN_ON_CAP);
		await putRelayHints(eventId, merged);
	});
	pending.set(eventId, op);
	void op.then(() => {
		// Only drop the slot if this op is still the tail (a newer op chained
		// on us keeps the map entry alive).
		if (pending.get(eventId) === op) pending.delete(eventId);
	});
}

/** Insertion-ordered seen-on relays for `eventId`, ≤ SEEN_ON_CAP. Empty when
 * unobserved or cached-only (recorded via another path, e.g. cold-open). */
export async function seenOnRelays(eventId: string): Promise<string[]> {
	return (await getRelayHints(eventId))?.relays ?? [];
}
