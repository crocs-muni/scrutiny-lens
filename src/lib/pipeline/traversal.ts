/**
 * §8.2 traversal fetch (lens #68, tools #75) — the context legs discovery
 * can never reach: patches carry no i tags (§8.1 step 4 excludes them there),
 * bindings likewise, and kind-5 deletions carry no #t filter hook (§3.2).
 *
 *   fetchSubjectContext(subjectId) — per dossier open:
 *     round 1 — the chain's patches (patchesReferencing, one root-anchored
 *               query reaches every depth since each patch carries `e root`,
 *               PT-1) plus the subject's own deletions (deletionsFor, DQ-2);
 *     round 2 — deletionsFor every patch round 1 surfaced (DQ-2 polls per
 *               cached patch: a retracted patch must drop out of the chain).
 *
 *   fetchSessionContext(admitted) — one settle pass after the search lands
 *     (lens #68 completion; plan comment on the issue, 2026-09-14):
 *     round 1 — bindingsReferencing unioned over every admitted
 *               product/metadata id, plus deletionsFor unioned over the whole
 *               admitted set (DQ-2 first sight);
 *     round 2 — ONE bounded second hop: the bound bindings' missing endpoint
 *               events by id (so Files rows and metadata deep-links resolve,
 *               BD-6), plus deletionsFor every new arrival. No third hop.
 *
 *   fetchSubjectDeletions(subjectId, contextIds) — the DQ-2 periodic re-poll:
 *     every dossier OPEN re-issues the cheap deletion legs for a subject
 *     whose full traversal already ran (retraction pills re-derive in place);
 *     patches/bindings themselves stay once-per-subject-per-session
 *     (contextFetched precedent).
 *
 * One route per KIND of leg: a route's filters are merged into ONE REQ with
 * nostr-tools' mergeFilters, which UNIONs values key-by-key. That union is
 * exactly the NIP-01 OR we want between SAME-SHAPE filters (per-id
 * bindingsReferencing instances union only their `#e` values), but merging
 * across kinds ANDs incompatible shapes: the kind-1 patch/binding filter
 * merged with the kind-5 deletion filter yields
 * {kinds:[1,5], '#t':['scrutiny-patch'], '#e':[id]}, whose `#t` key kills
 * exactly the deletions (they carry no `scrutiny-*` t tags, §3.2) while still
 * returning patches — silently losing half the leg behind a healthy-looking
 * answer.
 *
 * Every `#e` traversal result is classified by type tag AND marker per DQ-4
 * using core helpers only: scrutinyEventType for the tag, bindingEndpoints /
 * classifyByRole for the markers — relay answers are untrusted.
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
	bindingEndpoints,
	bindingsReferencing,
	classifyByRole,
	deletionsFor,
	patchesReferencing,
	scrutinyEventType,
	type CoreNostrEvent
} from '$lib/fabric';
import { filterWithTestTags } from '$lib/fabric/test-tags';
import type { FetchRoute, RelayStatus, Transport } from '$lib/net/transport';

/** Bound on the settle pass's second hop: ids fetched per session — a
 * malicious relay answering thousands of bindings must not turn the lookup
 * leg into an unbounded crawl. Excess ids are reported (capped), never
 * silently dropped. */
export const SECOND_HOP_ID_CAP = 128;

/** One fetchRouted round's honest receipt — relay statuses per round, so the
 * caller can tell a dead traversal (spec §4-class notice) from an empty one. */
export interface TraversalRound {
	label: string;
	relays: RelayStatus[];
}

/** Shared traversal result: fetched events (deduped by id; admission stays
 * the caller's gate — the fabric seam owns protocol judgment), the rounds'
 * relay statuses, and how many second-hop endpoint ids the cap dropped. */
export interface SessionContextResult {
	events: NostrEvent[];
	rounds: TraversalRound[];
	capped: number;
}

/** Union one round's events into the accumulator by id — the transport
 * dedupes within a round; across rounds the caller must. */
function mergeById(events: NostrEvent[], additions: NostrEvent[]): void {
	const seen = new Set(events.map((event) => event.id));
	for (const event of additions) {
		if (seen.has(event.id)) continue;
		seen.add(event.id);
		events.push(event);
	}
}

/** §8.2 traversal events for one subject, deduped by id. Admission stays
 * the caller's gate (the fabric seam owns protocol judgment). */
export async function fetchSubjectContext(
	subjectId: string,
	urls: string[],
	transport: Transport
): Promise<SessionContextResult> {
	// `as Filter`: core's EventFilter is deeply readonly, nostr-tools' Filter
	// mutable — the same boundary cast routeSearch already makes (pipeline).
	const roundOne: FetchRoute[] = [
		{ label: 'traversal:patches', urls, filters: [filterWithTestTags(patchesReferencing(subjectId)) as Filter] },
		{ label: 'traversal:deletions:subject', urls, filters: [deletionsFor(subjectId) as Filter] }
	];
	const first = await transport.fetchRouted(roundOne, () => {});
	const events = [...first.events];
	const rounds: TraversalRound[] = [{ label: 'traversal:round1', relays: first.relays }];

	// Deletion polls target only patches bound to THIS subject: expected
	// type plus a marked e-tag naming it (DQ-4 via core's classifyByRole —
	// relay answers are untrusted).
	const patches = classifyByRole(first.events as unknown as CoreNostrEvent[], subjectId, 'patch');
	if (patches.length === 0) return { events, rounds, capped: 0 };

	const roundTwo: FetchRoute[] = patches.map(({ event }) => ({
		label: `traversal:deletions:patch:${event.id}`,
		urls,
		filters: [deletionsFor(event.id) as Filter]
	}));
	const second = await transport.fetchRouted(roundTwo, () => {});
	rounds.push({ label: 'traversal:round2', relays: second.relays });
	mergeById(events, second.events);
	return { events, rounds, capped: 0 };
}

/** Ids of the patches and bindings core's classifyByRole binds to a subject
 * (expected type AND a marked e-tag naming it, DQ-4) — the re-poll targets
 * for that subject. Pure over the admitted array; unsorted, admitted order. */
export function boundContextIds(admitted: NostrEvent[], subjectId: string): string[] {
	const core = admitted as unknown as CoreNostrEvent[];
	return [
		...classifyByRole(core, subjectId, 'patch'),
		...classifyByRole(core, subjectId, 'binding')
	].map((match) => match.event.id);
}

export async function fetchSessionContext(
	admitted: NostrEvent[],
	urls: string[],
	transport: Transport
): Promise<SessionContextResult> {
	if (admitted.length === 0) return { events: [], rounds: [], capped: 0 };
	const admittedIds = new Set(admitted.map((event) => event.id));

	// DQ-4's type-tag half decides which admitted events are graph NODES —
	// bindingsReferencing legs fire per product/metadata id only.
	const coreAdmitted = admitted as unknown as CoreNostrEvent[];
	const nodeIds = coreAdmitted
		.filter((event) => {
			const type = scrutinyEventType(event);
			return type === 'product' || type === 'metadata';
		})
		.map((event) => event.id);

	// Same-shape filters union safely (see header): per-id builders merge into
	// ONE REQ whose `#e` values OR — the whole point of the batched pass.
	const roundOne: FetchRoute[] = [];
	if (nodeIds.length > 0) {
		roundOne.push({
			label: 'traversal:bindings',
			urls,
			filters: nodeIds.map((id) => filterWithTestTags(bindingsReferencing(id)) as Filter)
		});
	}
	roundOne.push({
		label: 'traversal:deletions',
		urls,
		filters: [...admittedIds].map((id) => deletionsFor(id) as Filter)
	});

	const first = await transport.fetchRouted(roundOne, () => {});
	const events = [...first.events];
	const rounds: TraversalRound[] = [{ label: 'traversal:round1', relays: first.relays }];

	// DQ-4 on every kind-1 answer (core helpers only — never hand-rolled):
	// the `scrutiny-binding` type tag, exactly-one-root/one-link markers via
	// bindingEndpoints, and a marked endpoint naming one of OUR nodes. A
	// PT-valid binding for another pair slipped into the answer spawns no
	// endpoint REQ and no deletion poll.
	const deliveredIds = new Set(events.map((event) => event.id));
	const arrivalIds: string[] = [];
	const missing = new Set<string>();
	// A counterparty the relay already delivered in round 1 is still a NEW
	// ARRIVAL — DQ-2 first-sight polling covers it even though no id fetch
	// is needed for it.
	const deliveredCounterparties = new Set<string>();
	for (const event of events) {
		if (event.kind !== 1) continue;
		const core = event as unknown as CoreNostrEvent;
		if (scrutinyEventType(core) !== 'binding') continue;
		const endpoints = bindingEndpoints(core);
		if (endpoints === undefined) continue;
		if (!nodeIds.includes(endpoints.rootId) && !nodeIds.includes(endpoints.linkId)) continue;
		arrivalIds.push(event.id);
		for (const endpointId of [endpoints.rootId, endpoints.linkId]) {
			if (admittedIds.has(endpointId)) continue;
			if (deliveredIds.has(endpointId)) {
				deliveredCounterparties.add(endpointId);
				continue;
			}
			missing.add(endpointId);
		}
	}

	// Deterministic order so the cap bites the same way on every run.
	const sortedMissing = [...missing].sort();
	const taken = sortedMissing.slice(0, SECOND_HOP_ID_CAP);
	const capped = sortedMissing.length - taken.length;
	// First-sight deletion polls (DQ-2): every new binding, every endpoint
	// actually fetched or already delivered (capped-out ids were never
	// retrieved — polling a deletion for an event we do not hold judges
	// nothing).
	const pollIds = [...arrivalIds, ...taken, ...deliveredCounterparties];
	if (pollIds.length === 0) return { events, rounds, capped };

	const roundTwo: FetchRoute[] = [];
	if (taken.length > 0) {
		roundTwo.push({
			label: 'traversal:bindings:endpoints',
			urls,
			// Hand-built { ids } — the one filter here not from a core
			// builder; core has no by-id lookup yet (tools #78). No protocol
			// judgment is involved: the referencing events named these ids.
			filters: [{ ids: taken }]
		});
	}
	if (pollIds.length > 0) {
		roundTwo.push({
			label: 'traversal:deletions:arrivals',
			urls,
			filters: pollIds.map((id) => deletionsFor(id) as Filter)
		});
	}

	const second = await transport.fetchRouted(roundTwo, () => {});
	rounds.push({ label: 'traversal:round2', relays: second.relays });
	mergeById(events, second.events);
	return { events, rounds, capped };
}

/** DQ-2 periodic re-poll (dossier-open policy): the subject's and its bound
 * context's deletion legs, unioned into ONE route. Cheap by design — it
 * repeats on every dossier open without refetching patches or bindings. */
export async function fetchSubjectDeletions(
	subjectId: string,
	contextIds: string[],
	urls: string[],
	transport: Transport
): Promise<SessionContextResult> {
	const label = 'traversal:deletions:repoll';
	const ids = [subjectId, ...contextIds.filter((id) => id !== subjectId)];
	const result = await transport.fetchRouted(
		[
			{
				label,
				urls,
				filters: ids.map((id) => deletionsFor(id) as Filter)
			}
		],
		() => {}
	);
	return {
		events: result.events,
		rounds: [{ label, relays: result.relays }],
		capped: 0
	};
}

/**
 * Spec §4-class honesty text for a settled traversal (never a thrown one —
 * the caller names the exception's own failure class): silent when every
 * covered relay answered, otherwise numeric about how many relays the context
 * fetch skipped and what may read as missing. A relay dead in ANY round
 * counts as skipped; coverage is the union of relays any round saw.
 */
export function traversalNoticeText(rounds: TraversalRound[]): string | undefined {
	// A relay that answered ok in round 1 but died in round 2 still left that
	// round's data on the table — dead-in-ANY-round counts as skipped.
	const dead = new Set<string>();
	const covered = new Set<string>();
	for (const round of rounds) {
		for (const relay of round.relays) {
			covered.add(relay.url);
			if (relay.status !== 'ok') dead.add(relay.url);
		}
	}
	if (dead.size === 0) return undefined;
	const stakes = 'Files counts and retraction pills may be incomplete';
	if (dead.size === covered.size) {
		return `context fetch failed — all relays unreachable — ${stakes}`;
	}
	return `context fetch skipped ${dead.size} of ${covered.size} relays — ${stakes}`;
}
