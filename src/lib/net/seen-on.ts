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
import { getRelayHints, saveRelayHint } from '$lib/db';

/** Max hints kept per event; must stay ≥ buildShareLinks' ≤3 slice. */
export const SEEN_ON_CAP = 4;

/**
 * Records that `relayUrl` returned `eventId`, first-observed-wins in
 * insertion order, trimming past SEEN_ON_CAP. Fire-and-forget: the merge
 * runs in ONE readwrite transaction (db saveRelayHint — the codebase's
 * existing race fix, saveInterpretation/review T-1), so concurrent calls
 * from fetchRouted's per-relay legs cannot lose a hint and transport
 * ingest never waits on IDB. Never throws: attempt() degrades every IDB
 * failure to memory-only (spec §6).
 */
export function recordSeenOn(eventId: string, relayUrl: string): void {
	void saveRelayHint(eventId, relayUrl, SEEN_ON_CAP);
}

/** Insertion-ordered seen-on relays for `eventId`, ≤ SEEN_ON_CAP. Empty when
 * unobserved or cached-only (recorded via another path, e.g. cold-open). */
export async function seenOnRelays(eventId: string): Promise<string[]> {
	return (await getRelayHints(eventId))?.relays ?? [];
}
