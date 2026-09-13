/**
 * §8.2 traversal fetch (lens #68, tools #75) — the dossier-context legs
 * discovery can never reach: patches carry no i tags (§8.1 step 4 excludes
 * them there) and kind-5 deletions carry no #t filter hook (§3.2). Fired
 * per dossier subject:
 *
 *   round 1 — the chain's patches (patchesReferencing, one root-anchored
 *             query reaches every depth since each patch carries `e root`,
 *             PT-1) plus the subject's own deletions (deletionsFor, DQ-2);
 *   round 2 — deletionsFor every patch round 1 observed (DQ-2 polls
 *             per cached patch: a retracted patch must drop out of the
 *             chain, and relays may store deletions they omit from
 *             default filter results).
 *
 * One route per filter: fetchRouted merges a route's filters into ONE REQ,
 * and merging the kind-1 patch filter with the kind-5 deletion filter would
 * AND their shapes (deletions never carry `scrutiny-*` t tags, §3.2) —
 * a merged REQ would answer nothing and look like an empty relay.
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
	DELETION_KIND,
	deletionsFor,
	patchesReferencing,
	scrutinyEventType,
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

	// Deletion polling targets patch-shaped events only (the relay answer is
	// untrusted; polling deletionsFor of any junk id it returned would turn
	// garbage answers into garbage REQs).
	const patches = events.filter(
		(event) =>
			event.kind !== DELETION_KIND &&
			scrutinyEventType(event as unknown as CoreNostrEvent) === 'patch'
	);
	if (patches.length === 0) return events;

	const roundTwo: FetchRoute[] = patches.map((patch) => ({
		label: `traversal:deletions:patch:${patch.id}`,
		urls,
		filters: [deletionsFor(patch.id) as Filter]
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
