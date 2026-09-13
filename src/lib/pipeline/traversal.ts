/**
 * §8.2 traversal fetch (lens #68, tools #75) — the dossier-context legs
 * discovery can never reach: patches carry no i tags (§8.1 step 4 excludes
 * them there) and kind-5 deletions carry no #t filter hook (§3.2). Fired
 * per dossier subject:
 *
 *   round 1 — the chain's patches (patchesReferencing, one root-anchored
 *             query reaches every depth since each patch carries `e root`,
 *             PT-1) plus the subject's own deletions (deletionsFor, DQ-2);
 *   round 2 — deletionsFor every patch round 1 surfaced (DQ-2 polls
 *             per cached patch: a retracted patch must drop out of the
 *             chain, and relays may store deletions they omit from
 *             default filter results).
 *
 * One route per filter: a route's filters are merged into ONE REQ with
 * nostr-tools' mergeFilters, which UNIONs values key-by-key — merging the
 * kind-1 patch filter with the kind-5 deletion filter yields
 * {kinds:[1,5], '#t':['scrutiny-patch'], '#e':[id]}, whose `#t` key kills
 * exactly the deletions (they carry no `scrutiny-*` t tags, §3.2) while
 * still returning patches — silently losing half the leg behind a
 * healthy-looking answer.
 *
 * Round-2 poll targets are the round-1 patches that classifyByRole binds
 * to THIS subject (expected type AND a marked e-tag naming it, DQ-4) —
 * a PT-valid patch an unrelated chain's relay slipped into the answer
 * never spawns a stray REQ.
 *
 * Deferrals (lens #68, owner ruling 2026-09-14 — named here per #68's
 * own call-out requirement): bindings legs (`bindingsReferencing` per
 * admitted product/metadata + second hop, the Files-count/deep-link
 * acceptance), search-time first-sight deletion polling for every cached
 * event (DQ-2's first half), and periodic re-poll (DQ-2's second half).
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
	classifyByRole,
	deletionsFor,
	patchesReferencing,
	type CoreNostrEvent
} from '$lib/fabric';
import type { FetchRoute, Transport } from '$lib/net/transport';

/** Traversal events for one subject, deduped by id (relay-merged already by
 * the transport per round; the union across rounds dedupes here). Admission
 * stays the caller's gate (the fabric seam owns protocol judgment). */
export async function fetchSubjectContext(
	subjectId: string,
	urls: string[],
	transport: Transport
): Promise<NostrEvent[]> {
	// `as Filter`: core's EventFilter is deeply readonly, nostr-tools' Filter
	// mutable — the same boundary cast routeSearch already makes (pipeline).
	const roundOne: FetchRoute[] = [
		{ label: 'traversal:patches', urls, filters: [patchesReferencing(subjectId) as Filter] },
		{ label: 'traversal:deletions:subject', urls, filters: [deletionsFor(subjectId) as Filter] }
	];
	const first = await transport.fetchRouted(roundOne, () => {});
	const events = [...first.events];

	// Deletion polls target only patches bound to THIS subject: expected
	// type plus a marked e-tag naming it (DQ-4 via core's classifyByRole —
	// relay answers are untrusted).
	const patches = classifyByRole(events as unknown as CoreNostrEvent[], subjectId, 'patch');
	if (patches.length === 0) return events;

	const roundTwo: FetchRoute[] = patches.map(({ event }) => ({
		label: `traversal:deletions:patch:${event.id}`,
		urls,
		filters: [deletionsFor(event.id) as Filter]
	}));
	const second = await transport.fetchRouted(roundTwo, () => {});
	const seen = new Set(events.map((event) => event.id));
	for (const event of second.events) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		events.push(event);
	}
	return events;
}
