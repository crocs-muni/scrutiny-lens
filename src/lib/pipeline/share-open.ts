/**
 * Cold-open resolution for issue #31 share links (spec §1 L22, §8).
 *
 * A share link's nevent carries up to 3 seen-on relay hints plus author and
 * kind (deep-link.ts). The RECIPIENT's app resolves the shared root here,
 * then investigation.openShared adopts it as a one-subject run (progressive
 * fill untouched — spec §8 "uninterpreted first").
 *
 * Resolution order (spec §6 cache-first, spec §8):
 *   1. Already in the local cache → opened with NO relay contact and NO
 *      relay claim (never lie: "seen on X" is reported only by a transport
 *      that actually observed the event, and nothing was contacted here).
 *   2. Otherwise the HINTED relays (first observed order, ≤3) are queried
 *      for the event id exactly. This is a plain NIP-01 ids filter — the
 *      cold open asks relays for one known event, so NIP-50 search
 *      capability is irrelevant.
 *   3. No hints at all (the shareer's own copy was cache-only) → the
 *      RECEIVER's configured relay pool is queried — the same set a fresh
 *      search would use — so a hintless link still resolves when the event
 *      is live on the network.
 *
 * Admission (spec §3): the shared bytes must pass the same gate any search
 * result enters before they are adopted or cached — tamper/id recompute +
 * core validity (fabric admitEvent) — and only product/metadata roots are
 * shareable cards (the drawer's subjects; a binding or patch is a chain
 * member, not a card). A rejected event throws ShareRejectedError, never a
 * card.
 *
 * Failure honesty (spec §4): every hinted relay that failed to answer
 * (refused/timed out) is returned as a failedHint so the recipient can be
 * told which of the shareer's hints died. A relay that answered ok with no
 * copy is NOT a failure — it was reachable and said so.
 */
import type { SharePointer } from '$lib/share/deep-link';
import { createTransport, type PoolFactory } from '$lib/net/transport';
import { getEvent } from '$lib/db';
import { indexEvent } from '$lib/search';
import { admitEvent, type NostrEvent as FabricEvent } from '$lib/fabric';
import { settings } from '$lib/settings.svelte';

export interface ShareOpenResult {
	/** The shared root event id (== pointer.id). */
	subjectId: string;
	/** Hinted relays that failed to answer (refused/timed out), in hint
	 * order — empty when the event opened from cache or every hint worked. */
	failedHints: string[];
}

/** Thrown when the shared event could not be found anywhere. `triedRelays`
 * carries the FAILED relay urls of the attempt (hinted relays that refused/
 * timed out), so the caller can tell the recipient which of them died
 * (spec §4) — relays that answered ok with no copy are not listed. */
export class ShareNotFoundError extends Error {
	constructor(public triedRelays: string[]) {
		super('the shared record was not found on any relay');
		this.name = 'ShareNotFoundError';
	}
}

/** Thrown when the resolved event fails admission (tampered/invalid, or
 * not a shareable product/metadata card root) — message names the reason
 * verbatim so the cold open never guesses (spec §2 never-lie). */
export class ShareRejectedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'ShareRejectedError';
	}
}

/** One admission gate for every resolved root (spec §3): tamper check,
 * core validity, and the product/metadata-openable rule — the drawer may
 * only open on product/metadata subjects (the card roots the share
 * affordance attaches to); bindings and patches are chain members of a
 * dossier, never its subject. Throws ShareRejectedError with the honest
 * reason otherwise. */
function gateAdmission(event: FabricEvent): void {
	const verdict = admitEvent(event);
	if (!verdict.ok) throw new ShareRejectedError(verdict.reason);
	if (verdict.type !== 'product' && verdict.type !== 'metadata') {
		throw new ShareRejectedError(
			`the shared record is a ${verdict.type} — only product and metadata cards can be opened`
		);
	}
}

/**
 * Resolves a decoded share pointer to the shared root event. The root is
 * admission-gated and cached (awaiting the write so the caller's follow-up
 * cache read is consistent); throws ShareNotFoundError when the event is
 * nowhere reachable and ShareRejectedError when it fails admission.
 * `poolFactory` is the same injectable test seam as createTransport's
 * (production callers omit it).
 */
export async function openSharedRecord(
	pointer: SharePointer,
	poolFactory?: PoolFactory
): Promise<ShareOpenResult> {
	// Cache-first (spec §6): a recipient who already holds the event (an
	// earlier investigation cached it) opens instantly — no relay contact,
	// no relay claim, cache provenance is honest on its own. Cached entries
	// are normally pre-admitted, but the cold open never assumes: the gate
	// still runs on the cached bytes.
	const cached = await getEvent(pointer.id);
	if (cached !== null) {
		gateAdmission(cached as unknown as FabricEvent);
		return { subjectId: pointer.id, failedHints: [] };
	}

	// Hintless links fall back to the receiver's configured pool — the same
	// set a fresh search would use (spec §8). Dedupe: a hostile or sloppy
	// nevent may repeat a hint, and fetchRouted would query it twice.
	const relays = [...new Set(pointer.relays.length > 0 ? pointer.relays : settings.relays)];
	if (relays.length === 0) throw new ShareNotFoundError([]);

	const transport = createTransport({ urls: relays }, poolFactory);
	try {
		const { events, relays: statuses } = await transport.fetchRouted(
			[{ label: 'cold-open', urls: relays, filters: [{ ids: [pointer.id] }] }],
			() => {}
		);
		// A relay that answered ok with zero events is reachable and said so —
		// only the refused/timed-out legs are failures to report (spec §4).
		const failedHints = statuses.filter((s) => s.status !== 'ok').map((s) => s.url);
		const found = events[0];
		if (found === undefined) throw new ShareNotFoundError(failedHints);

		gateAdmission(found as unknown as FabricEvent);
		// Cache write-through (spec §6): the event route re-reads this from
		// the cache to adopt it, and a revisit of the same link — or a search
		// that finds the event — hits cache-first instead of re-fetching.
		// Awaited so the caller's follow-up getEvent never races the write;
		// indexEvent never throws (memory-only degrade no-ops, spec §6).
		await indexEvent(found as unknown as FabricEvent);
		return { subjectId: pointer.id, failedHints };
	} finally {
		// One pool per resolution: close its relay websockets when it settles
		// (same lifecycle rule as investigation.start, spec §8).
		await transport.close();
	}
}
