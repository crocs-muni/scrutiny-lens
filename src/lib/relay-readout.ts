/**
 * Per-relay readout for one run (issues #131/#132).
 *
 * The trace's literal layer is per-LEG: the pipeline emits one slice per
 * (search, relay) leg, so a relay that answered two searches and refused a
 * third shows up three times. Everything a human wants to know about a relay
 * — "did it work, how many legs did we ask it, how much came back" — is a
 * per-RELAY question, and answering it in the UI over raw slices invites the
 * #132 class of bug: the same relay displayed twice with contradictory
 * verdicts. This module folds the run's slices to exactly one receipt per
 * relay, deterministically, so any surface (trace, dossier, export) reads the
 * same answer.
 */

import type { RelayState } from '$lib/net/transport';

/** One relay's run-level verdict. */
export interface RelayReceipt {
	url: string;
	/** Folded leg status. 'unasked' never comes out of aggregatePerRelay (it
	 * reports only observed legs) — the arm exists for a pool-relative
	 * readout: a relay the run's snapshot names but no leg ever reached. */
	status: RelayState | 'unasked';
	/** Distinct routed legs that touched this relay (cache excluded).
	 * ABSENT — never zero — when the receipt came from a recorded run whose
	 * fold did not count legs: unknown stays unrecorded (spec §2), zero
	 * would claim observed-nothing. */
	routes?: number;
	/** Events the relay returned, summed over its legs. */
	received: number;
	/** Candidates its legs produced that admission rejected, summed.
	 * ABSENT under the same rule as routes: a fold that did not observe
	 * rejections carries nothing rather than zero. */
	rejected?: number;
}

/** The pipeline's cache slice label (pipeline/index.ts emits url
 * 'local-cache' under route 'cache'): a local read is not a relay and must
 * never appear in a relay readout (spec §2 — the trace names the relays that
 * were actually asked). */
const CACHE_URL = 'local-cache';
const CACHE_ROUTE = 'cache';

/** Fold precedence, best first. `ok` wins outright: one answering leg proves
 * the relay is reachable, and the run did get that leg's events — calling the
 * relay "refused" off another leg would retract receipts we hold. Among the
 * two failures `refused` outranks `timeout`: a refused connection is the
 * decisive explanation (the relay is unusable, which also explains its
 * silence), while a timeout may just be that leg's budget. */
const RANK: Record<RelayState, number> = { ok: 0, refused: 1, timeout: 2 };

/** Aggregate the run's per-leg slices to ONE receipt per relay (issue #132's
 * root: contradictory duplicate rows). First appearance of a url wins
 * position — the readout follows the run's own leg order, never a re-sort. */
export function aggregatePerRelay(
	slices: {
		url: string;
		received: number;
		rejected: number;
		route: string;
		status: RelayState;
	}[],
): RelayReceipt[] {
	const byUrl = new Map<
		string,
		{ url: string; best: RelayState; received: number; rejected: number; legs: Set<string> }
	>();
	for (const slice of slices) {
		if (slice.url === CACHE_URL || slice.route === CACHE_ROUTE) continue;
		let entry = byUrl.get(slice.url);
		if (entry === undefined) {
			entry = { url: slice.url, best: slice.status, received: 0, rejected: 0, legs: new Set() };
			byUrl.set(slice.url, entry);
		}
		entry.received += slice.received;
		entry.rejected += slice.rejected;
		if (RANK[slice.status] < RANK[entry.best]) entry.best = slice.status;
		// Legs are route labels: a relay re-asked on the SAME route (retry,
		// second hop) is one leg, not two — counting slices would inflate it.
		entry.legs.add(slice.route);
	}
	const out: RelayReceipt[] = [];
	for (const entry of byUrl.values()) {
		out.push({
			url: entry.url,
			status: entry.best,
			routes: entry.legs.size,
			received: entry.received,
			rejected: entry.rejected,
		});
	}
	return out;
}
