/**
 * Search pipeline orchestrator (issue #28, spec §1/§2/§3/§11 step 2).
 *
 * translate → capability-aware fan-out → admit+cache → skeleton sources →
 * session. Every surface the UI can read is computed HERE, deterministically:
 * phases, per-route counters, notices (capability / truncation / skipped)
 * — spec §2.6's "the honest version" of the progress surface. Nothing in
 * this module writes AI prose; card interpretation is #29+ downstream of
 * the session's admitted events.
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { CallLLM } from '$lib/ai/output';
import type { ProviderOverrideInput } from '$lib/ai/provider';
import { admitEvent } from '$lib/fabric';
import { indexerFilter, searchFilter, fullScanFilter, tTags, tagValues } from '$lib/fabric';
import type { NostrEvent as FabricEvent } from '$lib/fabric';
import type { Transport, RelayCapability, RelayStatus, FetchRoute, FetchSlice } from '$lib/net/transport';
import { translateQuestion, type SearchRequest } from '$lib/ai/agents/query';
import { indexEvent } from '$lib/search';

export type Phase = 'translate' | 'capability' | 'fetch' | 'done';

export interface PipelineNotice {
	kind: 'capability' | 'truncated' | 'invalid-skipped' | 'relay-dead';
	message: string;
}

/** Rule-5 skeleton source (spec §2): the event speaks for itself — i-tags,
 * type tag, first ~200 chars. Cards render this instantly; AI replaces
 * content later, the marker survives only while uninterpreted. */
export interface SkeletonCard {
	id: string;
	itags: string[];
	typeTag?: string;
	contentStart: string;
	interpreted: false;
}

export interface SearchSession {
	searches: SearchRequest[];
	admitted: NostrEvent[];
	invalidSkipped: number;
	notices: PipelineNotice[];
	relays: RelayStatus[];
}

export type PipelineEvent =
	| { type: 'phase'; phase: Phase }
	| { type: 'slice'; url: string; received: number; route: string }
	| { type: 'skeleton'; cards: SkeletonCard[] }
	| { type: 'notice'; notice: PipelineNotice };

export interface RunSearchOptions {
	question: string;
	relays: string[];
	provider?: ProviderOverrideInput;
	callLLM: CallLLM;
	transport: Transport;
	/** Admission seam — production default is the fabric admit; tests inject. */
	admit?: (event: NostrEvent) => { ok: boolean };
	signal?: AbortSignal;
	emit?: (event: PipelineEvent) => void;
}

const CONTENT_START = 200;

/** One filter leg per (search, relay-group) pairing — the routing decision
 * lives here so TaskRows can quote it verbatim (spec §2.6). Labels carry
 * the search value so truncation counts attribute per search, not per mode. */
function routeSearch(
	search: SearchRequest,
	relays: string[],
	caps: Map<string, RelayCapability>,
	notices: PipelineNotice[]
): FetchRoute[] {
	const label = `${search.kind}:${search.value}`;
	if (search.kind === 'tag') {
		// nostr-tools Filter vs core EventFilter: same wire surface, so the cast
		// is safe — the builder's shape is the nostr type's readonly version.
		return [{ label, urls: relays, filters: [indexerFilter(search.value) as Filter] }];
	}
	// freetext: the relay capability hint decides NIP-50 vs full scan. An
	// 'unknown' relay gets the search anyway — absent info never means
	// incapable (critique A2; nips#1319).
	const lacks = relays.filter((u) => (caps.get(u) ?? 'unknown') === 'lacks');
	const routes: FetchRoute[] = [];
	const nip50 = relays.filter((u) => (caps.get(u) ?? 'unknown') !== 'lacks');
	if (nip50.length > 0) routes.push({ label, urls: nip50, filters: [searchFilter(search.value) as Filter] });
	if (lacks.length > 0) {
		routes.push({ label, urls: lacks, filters: [fullScanFilter() as Filter] });
		for (const url of lacks) {
			notices.push({
				kind: 'capability',
				message: `relay ${url} lacks search support — falling back to a tag scan`
			});
		}
	}
	return routes;
}

/** Skeleton source — deterministic, interprets nothing (spec §2 rule 5):
 * i-tags + type tag + the first ~200 chars. */
function skeletonOf(event: NostrEvent): SkeletonCard {
	const ttags = [...new Set(tTags(event as unknown as FabricEvent))];
	return {
		id: event.id,
		itags: [...new Set(tagValues(event as unknown as FabricEvent, 'i'))],
		typeTag: ttags.find((t) => ['scrutiny-product', 'scrutiny-metadata', 'scrutiny-binding', 'scrutiny-patch'].includes(t)),
		contentStart: event.content.slice(0, CONTENT_START),
		interpreted: false
	};
}

/** NIP-45 truncation honesty: COUNT > fetched means "relays may hold more" (spec §3). */
async function truncationNotices(
	routes: FetchRoute[],
	perRouteReceived: Map<string, number>,
	transport: Transport,
	notices: PipelineNotice[]
): Promise<void> {
	await Promise.all(
		routes.map(async (route) => {
			const count = await transport.count(route.filters);
			const fetched = perRouteReceived.get(route.label) ?? 0;
			if (count.total > fetched) {
				notices.push({
					kind: 'truncated',
					message: `fetched ${fetched} (relays may hold more — COUNT ${count.total})`
				});
			}
		})
	);
}

export async function runSearch(opts: RunSearchOptions): Promise<SearchSession> {
	const emit = opts.emit ?? (() => {});
	const notices: PipelineNotice[] = [];
	const admittedSet = new Map<string, NostrEvent>();
	let invalidSkipped = 0;
	const admit = opts.admit ?? ((e: NostrEvent) => admitEvent(e as unknown as FabricEvent));

	emit({ type: 'phase', phase: 'translate' });
	const plan = await translateQuestion({
		question: opts.question,
		provider: opts.provider,
		callLLM: opts.callLLM,
		signal: opts.signal
	});

	emit({ type: 'phase', phase: 'capability' });
	const caps = new Map<string, RelayCapability>();
	await Promise.all(opts.relays.map(async (url) => caps.set(url, await opts.transport.capability(url))));

	emit({ type: 'phase', phase: 'fetch' });
	const routes = (plan.ok ? plan.result.searches : []).flatMap((search) =>
		routeSearch(search, opts.relays, caps, notices)
	);
	const perRouteReceived = new Map<string, number>();
	let relays: RelayStatus[] = [];
	// The session does not resolve before its events landed in the cache —
	// the ui's "cache-first" repeat-query guarantee depends on it.
	const pendingWrites: Promise<unknown>[] = [];

	const onSlice = (slice: FetchSlice): void => {
		emit({ type: 'slice', url: slice.url, received: slice.events.length, route: slice.route ?? 'default' });
		perRouteReceived.set(slice.route ?? 'default', (perRouteReceived.get(slice.route ?? 'default') ?? 0) + slice.events.length);
		const skeletons: SkeletonCard[] = [];
		for (const event of slice.events) {
			if (admittedSet.has(event.id)) continue;
			const verdict = admit(event);
			if (!verdict.ok) {
				invalidSkipped += 1;
				continue;
			}
			admittedSet.set(event.id, event);
			skeletons.push(skeletonOf(event));
			// fire-and-forget cache write — the host degrades silently per spec §6;
			// the session only resolves once every queued write has settled.
			pendingWrites.push(indexEvent(event).catch(() => {}));
		}
		if (skeletons.length > 0) emit({ type: 'skeleton', cards: skeletons });
	};

	if (routes.length > 0) {
		const result = await opts.transport.fetchRouted(routes, onSlice);
		relays = result.relays;
	}

	await Promise.all(pendingWrites);
	await truncationNotices(routes, perRouteReceived, opts.transport, notices);

	if (invalidSkipped > 0) {
		notices.push({ kind: 'invalid-skipped', message: `${invalidSkipped} invalid skipped` });
	}

	emit({ type: 'phase', phase: 'done' });
	for (const notice of notices) emit({ type: 'notice', notice });

	return {
		searches: plan.ok ? plan.result.searches : [],
		admitted: [...admittedSet.values()],
		invalidSkipped,
		notices,
		relays
	};
}
