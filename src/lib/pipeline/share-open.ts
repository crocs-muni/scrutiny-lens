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
 *   3. When the link names the author but the hints missed, the hint ∪
 *      configured relays are asked for the author's NIP-65 relay list
 *      (kind 10002) and up to 3 freshly-discovered WRITE relays are then
 *      queried for the id — a dead-hint link still resolves when the
 *      shareer switched relays between publishing and sharing.
 *   4. Finally, the RECEIVER's configured relay pool is queried — the
 *      same set a fresh search would use — so a hintless link still
 *      resolves when the event is live on the network.
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
 * copy is NOT a failure — it was reachable and said so. When nothing was
 * found, EVERY failed leg (hints, NIP-65 sources, configured pool) is
 * carried as triedRelays, and `answeredOk` records whether ANY relay
 * answered ok — the caller must distinguish "reachable relays held no
 * copy" from "the relays could not be reached", and never claim the
 * relays failed when they answered.
 *
 * What was actually asked (issue #131, spec §2 never-lie): the cold open is
 * one resolution with several legs, and the trace readout counts RELAYS.
 * The result therefore carries one receipt per relay this resolution really
 * asked (legs folded, so a relay that answered one leg and died on another
 * is ONE relay with ONE verdict) plus where the root came from — a cache
 * hit asked no relay at all, so nothing may be rendered as "0 of <pool>
 * answered" for a question that was never put to them.
 */
import type { SharePointer } from '$lib/share/deep-link';
import {
	createTransport,
	type PoolFactory,
	type RelayState,
	type RelayStatus
} from '$lib/net/transport';
import { getEvent } from '$lib/db';
import { indexEvent } from '$lib/search';
import { admitEvent, type NostrEvent as FabricEvent } from '$lib/fabric';
import { aggregatePerRelay, type RelayReceipt } from '$lib/relay-readout';
import { canonicalRelayUrls } from '$lib/net/relay-url';
import { settings } from '$lib/settings.svelte';

/** One relay's verdict for this resolution (issue #131): every leg that
 * asked it folded into one status, so a relay can never appear twice with
 * contradictory answers. Carries the FULL RelayReceipt shape — the fold
 * already counts bytes and legs, and throwing them away here only forced
 * openShared to re-invent zeros. */
export type ShareOpenReceipt = RelayReceipt;

export interface ShareOpenResult {
	/** The shared root event id (== pointer.id). */
	subjectId: string;
	/** Hinted relays that failed to answer (refused/timed out), in hint
	 * order — empty when the event opened from cache or every hint worked. */
	failedHints: string[];
	/** Where the root came from (issue #131): 'cache' means NO relay was
	 * contacted (spec §6 cache-first), so the cold open has no relay story
	 * to tell — 'relays' means the receipts below are the whole attempt. */
	openedFrom: 'cache' | 'relays';
	/** One receipt per relay actually asked, in first-asked order, legs
	 * folded (issue #131, spec §2): the trace's source counter is "how many
	 * of the relays we asked answered", not "how many relays are
	 * configured". Empty on a cache hit. */
	receipts: ShareOpenReceipt[];
}

/** Thrown when the shared event could not be found anywhere. `triedRelays`
 * carries the FAILED relay urls of the whole attempt (hinted relays that
 * refused/timed out, failed NIP-65 sources, refused configured relays), so
 * the caller can tell the recipient which of them died (spec §4) — relays
 * that answered ok with no copy are not listed. `answeredOk` says whether
 * ANY relay answered ok during the attempt: true = reachable relays held
 * no copy (the hints may all have died, but the network answered);
 * false = nothing was reachable (every leg refused or timed out, or the
 * link carried no relays at all). The two states must never be rendered
 * as the same lie. */
export class ShareNotFoundError extends Error {
	constructor(public triedRelays: string[], public answeredOk = false) {
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

/** One (leg × relay) status fed to the receipt fold below. */
interface ShareOpenLeg {
	url: string;
	received: number;
	rejected: number;
	route: string;
	status: RelayState;
}

/** Folds this resolution's per-leg statuses to ONE receipt per relay in
 * first-asked order (issue #131, spec §2): a relay that answered one leg
 * and died on another is ONE relay with ONE verdict. The fold precedence is
 * relay-readout.ts's (ok > refused > timeout) so the cold open's own readout
 * and the trace can never disagree about the same relay. */
function foldReceipts(legs: ShareOpenLeg[]): RelayReceipt[] {
	// The fold IS the receipt (issue #131): bytes, leg counts and verdicts
	// all real — narrowing here only forced openShared to re-invent zeros.
	return aggregatePerRelay(legs);
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
		// Nothing was asked of any relay, so there is no receipt to report.
		return { subjectId: pointer.id, failedHints: [], openedFrom: 'cache', receipts: [] };
	}

	// Boot barrier (issue #131): the configured pool is read ONCE below and
	// becomes the pool this resolution asks and blames, so a cold open on a
	// fresh load must wait for the persisted Settings instead of querying
	// (and reporting on) the spec defaults while hydration is still in
	// flight. Single-flight and memoized: free after boot.
	await settings.ready();

	// Canonicalize BOTH input sets at this boundary (issue #131): a slashed
	// nevent hint must not double as a second copy of a configured relay —
	// the transport, receipts and every string-keyed ledger all share one
	// spelling per endpoint. Hinted relays arrive from other clients, so
	// invalid entries are dropped, not thrown.
	const hinted = canonicalRelayUrls(pointer.relays).urls;
	const configured = canonicalRelayUrls(settings.relays).urls;
	if (hinted.length + configured.length === 0) {
		// Nothing was contactable and nothing was even attempted — answeredOk
		// stays false so the caller never claims "relays answered" (spec §4).
		throw new ShareNotFoundError([]);
	}

	// ONE transport for all legs: the pool caches ensured relays, so the
	// fan-outs below share connections; closing between legs would destroy
	// the pool's cache (transport.close destroys it, transport.ts L391).
	const transport = createTransport(
		{ urls: [...new Set([...hinted, ...configured])] },
		poolFactory
	);
	// failedHints = the shareer's hint legs that died (spec §4, what the
	// link's footer blames); triedRelays = EVERY failed leg of the whole
	// attempt (what a not-found screen lists), deduped — the same relay
	// can refuse in several legs and must not be listed twice;
	// answeredOk = any relay answered ok anywhere (reachable, just no
	// copy); legs = every (leg × relay) status of the attempt, folded into
	// the per-relay receipts the caller gets back (issue #131).
	const failedHints: string[] = [];
	const triedRelays = new Set<string>();
	let answeredOk = false;
	const legs: ShareOpenLeg[] = [];
	/** Book one leg's statuses: the failure ledgers and the receipt fold
	 * read the SAME statuses, so this surface can never call a relay failed
	 * while the trace counts it answered. `hintLeg` scopes the failure
	 * ledger to the shareer's own hints (spec §4). */
	const noteLeg = (statuses: RelayStatus[], hintLeg: boolean): void => {
		for (const s of statuses) {
			legs.push({
				url: s.url,
				// The fold tracks per-relay bytes and leg labels from these
				// statuses; admission rejections never reach here: a rejected
				// root throws out of the resolution instead (gateAdmission).
				received: s.count,
				rejected: 0,
				// fetchRouted always labels its leg; the fallback keeps the
				// fold's per-relay leg count from keying on undefined.
				route: s.route ?? 'cold-open',
				status: s.status
			});
			if (s.status === 'ok') {
				answeredOk = true;
				continue;
			}
			if (hintLeg) failedHints.push(s.url);
			triedRelays.add(s.url);
		}
	};
	/** The relay-resolved result: the receipts cover the whole attempt so
	 * far — the leg that found the root is the last one noted. */
	const opened = (): ShareOpenResult => ({
		subjectId: pointer.id,
		failedHints,
		openedFrom: 'relays',
		receipts: foldReceipts(legs)
	});
	// Adopt the resolved root: the same admission gate (spec §3) runs on
	// whatever leg found it, and the event is cached write-through (spec §6)
	// so the caller's follow-up cache read is consistent and a revisit of
	// the link hits cache-first. Returns false when the leg held nothing.
	const adopt = async (events: FabricEvent[]): Promise<boolean> => {
		const found = events[0];
		if (found === undefined) return false;
		gateAdmission(found);
		// indexEvent never throws (memory-only degrade no-ops, spec §6).
		await indexEvent(found);
		return true;
	};
	try {
		// Leg 1 — the shareer's seen-on hints, first-observed order (spec
		// §8; deep-link.ts captures at most 3). An ok-but-empty hint relay
		// is reachable and said so: never a failure (spec §4 never-lie).
		if (hinted.length > 0) {
			const { events, relays: statuses } = await transport.fetchRouted(
				[{ label: 'cold-open', urls: hinted, filters: [{ ids: [pointer.id] }] }],
				() => {}
			);
			noteLeg(statuses, true);
			if (await adopt(events as FabricEvent[])) {
				return opened();
			}
		}

		// Leg 2 — NIP-65 relay discovery (NIP-65; spec §8 hintless links
		// still resolve): when the link names the author, ask the hint ∪
		// configured relays for the author's relay list (kind 10002). Core
		// has no event-type builder for it (it is not a SCRUTINY event), so
		// the filter is hand-shaped; core only ever gates the PRODUCT root,
		// never this list. r-tag markers: 'write' or absent = write-capable,
		// 'read' = read-only (a read-only relay is never queried for the id).
		const alreadyQueried = new Set<string>([...hinted, ...configured]);
		if (pointer.author !== undefined) {
			// The union is non-empty: the early throw above guarantees at
			// least one of hinted/configured exists.
			const sources = [...new Set([...hinted, ...configured])];
			const { events: relayLists, relays: statuses } = await transport.fetchRouted(
				[
					{
						label: 'nip65-list',
						urls: sources,
						filters: [{ kinds: [10002], authors: [pointer.author] }]
					}
				],
				() => {}
			);
			noteLeg(statuses, false);
			// Merge the write relays named by ANY returned 10002 list (the
			// author may publish different lists on different relays).
			const writeRelays = new Set<string>();
			for (const list of relayLists) {
				for (const tag of list.tags) {
					if (tag[0] === 'r' && tag[1] !== undefined && tag[2] !== 'read') {
						writeRelays.add(tag[1]);
					}
				}
			}
			// Canonicalize BEFORE the skip check and cap at 3, same budget the
			// original hint set had (deep-link.ts cap): r-tag values are raw
			// third-party strings, so the slashed spelling of an already-asked
			// relay would slip past `alreadyQueried` and become a second query
			// — and a second receipt — for one endpoint (issue #131: one relay,
			// one string, one question). Invalid entries drop here, never throw.
			const fresh = canonicalRelayUrls([...writeRelays])
				.urls.filter((u) => !alreadyQueried.has(u))
				.slice(0, 3);
			if (fresh.length > 0) {
				const { events, relays: hostStatuses } = await transport.fetchRouted(
					[
						{ label: 'nip65-host', urls: fresh, filters: [{ ids: [pointer.id] }] }
					],
					() => {}
				);
				noteLeg(hostStatuses, false);
				if (await adopt(events as FabricEvent[])) {
					return opened();
				}
			}
		}

		// Leg 3 — the receiver's own configured pool (spec §8), skipping
		// relays already asked in leg 1.
		const remaining = configured.filter((u) => !hinted.includes(u));
		if (remaining.length > 0) {
			const { events, relays: statuses } = await transport.fetchRouted(
				[
					{
						label: 'cold-open-fallback',
						urls: remaining,
						filters: [{ ids: [pointer.id] }]
					}
				],
				() => {}
			);
			noteLeg(statuses, false);
			if (await adopt(events as FabricEvent[])) {
				return opened();
			}
		}

		throw new ShareNotFoundError([...triedRelays], answeredOk);
	} finally {
		// One pool per resolution: close its relay websockets when it settles
		// (same lifecycle rule as investigation.start, spec §8).
		await transport.close();
	}
}
