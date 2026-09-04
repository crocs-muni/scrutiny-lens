/**
 * Search pipeline orchestrator (issue #28, spec §1/§2/§3/§11 step 2).
 *
 * translate → capability-aware fan-out (per relay — a slow relay probe
 * gates only its own leg) → cache-first reads (repeat queries labeled
 * cache-sourced) → admit+cache → skeleton sources → session. All phases,
 * counters, and notices are computed HERE, deterministically — spec §2.6's
 * honest progress surface. No AI prose is written at this layer.
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import type { CallLLM } from '$lib/ai/output';
import type { ProviderOverrideInput } from '$lib/ai/provider';
import { admitEvent } from '$lib/fabric';
import { indexerFilter, searchFilter, fullScanFilter, tTags, tagValues } from '$lib/fabric';
import type { NostrEvent as FabricEvent } from '$lib/fabric';
import type {
	Transport,
	RelayCapability,
	RelayState,
	RelayStatus,
	FetchRoute,
	FetchSlice
} from '$lib/net/transport';
import { translateQuestion, type SearchRequest } from '$lib/ai/agents/query';
import { indexEvent, searchText } from '$lib/search';
import { getEvent, getEventsByTag } from '$lib/db';

export type Phase = 'translate' | 'fetch' | 'done';

export interface PipelineNotice {
	kind: 'capability' | 'truncated' | 'invalid-skipped' | 'cache';
	message: string;
}

/** Rule-5 skeleton source (spec §2): the event speaks for itself — i-tags,
 * type tag, first ~200 chars. Cards render this instantly; AI fills in. */
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
	| { type: 'slice'; url: string; received: number; route: string; rejected: number; status: RelayState }
	| { type: 'searches'; searches: SearchRequest[] }
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

/** Per-(search, relay-group) route — one leg per relay-as-a-whole when
 * identical capability, split by NIP-50 vs fullscan. Labels carry
 * the search value so truncation counts attribute per leg (spec §2.6).
 */
function routeSearch(
	search: SearchRequest,
	relays: string[],
	caps: Map<string, RelayCapability>,
	notices: PipelineNotice[]
): FetchRoute[] {
	const label = `${search.kind}:${search.value}`;
	if (search.kind === 'tag') {
		// i-tag filters are NIP-01: every relay answers them (spec §3).
		return [{ label, urls: relays, filters: [indexerFilter(search.value) as Filter] }];
	}
	// freetext routing per relay group, leg labels UNIQUE — truncation COUNT
	// math borrows across legs when two legs share 'text:value' (review R2).
	const routes: FetchRoute[] = [];
	const nip50: string[] = [];
	const fullscan: string[] = [];
	for (const url of relays) {
		const cap = caps.get(url) ?? 'unknown';
		if (cap === 'lacks') {
			notices.push({
				kind: 'capability',
				message: `relay ${url} lacks search support · falling back to a tag scan`
			});
			fullscan.push(url);
		} else if (cap === 'unknown') {
			// Unverifiable → run BOTH legs: an unresponsive-but-capable relay
			// keeps its NIP-50 answer; an incapable one is still covered by the
			// tag scan. Dedupes downstream (spec §3 never-blank).
			notices.push({
				kind: 'capability',
				message: `relay ${url}'s search support couldn't be verified · trying NIP-50 and a tag scan`
			});
			nip50.push(url);
			fullscan.push(url);
		} else {
			nip50.push(url);
		}
	}
	if (nip50.length > 0) routes.push({ label: `${label}:nip50`, urls: nip50, filters: [searchFilter(search.value) as Filter] });
	if (fullscan.length > 0) routes.push({ label: `${label}:fullscan`, urls: fullscan, filters: [fullScanFilter() as Filter] });
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

/** Truncation honesty per leg (spec §3): only the relays the leg covered
 * may inflate COUNT; a fullScanFilter leg to a subset can never borrow the
 * NIP-50 pool's sum — that mistake would tell 'may hold more' on every
 * fallback and suppress the real one. COUNT is number-based, so this is an
 * approximation, not a bound. */
async function truncationNotices(
	routes: FetchRoute[],
	perRouteReceived: Map<string, number>,
	transport: Transport,
	notices: PipelineNotice[]
): Promise<void> {
	await Promise.all(
		routes.map(async (route) => {
			const count = await transport.count(route.filters);
			const covered = count.relays.filter((s) => route.urls.includes(s.url) && s.status === 'ok');
			const coveredCount = covered.reduce((sum, s) => sum + s.count, 0);
			const fetched = perRouteReceived.get(route.label) ?? 0;
			if (coveredCount > fetched) {
				notices.push({
					kind: 'truncated',
					message: `fetched ${fetched} (relays may hold more · COUNT ${coveredCount})`
				});
			}
		})
	);
}

export async function runSearch(opts: RunSearchOptions): Promise<SearchSession> {
	const emit = opts.emit ?? (() => {});
	const notices: PipelineNotice[] = [];
	const admittedSet = new Map<string, NostrEvent>();
	/** Invalid ids already admission-checked — the same bad event arriving
	 * from N relays is counted ONCE in the "N invalid skipped" footer. */
	const rejectedIds = new Set<string>();
	let invalidSkipped = 0;
	const admit = opts.admit ?? ((e: NostrEvent) => admitEvent(e as unknown as FabricEvent));

	emit({ type: 'phase', phase: 'translate' });
	const plan = await translateQuestion({
		question: opts.question,
		provider: opts.provider,
		callLLM: opts.callLLM,
		signal: opts.signal
	});
	const searches = plan.ok ? plan.result.searches : [];
	// issue #36: the trace's first row counts/names the searches as soon as
	// translation settles — the session itself only ships at the end.
	emit({ type: 'searches', searches });

	// ── Cache-first (issue #28 acceptance: repeat queries labeled cache) ─────
	const cachedEvents: NostrEvent[] = [];
	for (const search of searches) {
		const ids = search.kind === 'tag' ? await getEventsByTag(search.value) : await searchText(search.value);
		for (const id of ids) {
			const event = await getEvent(id);
			if (event) cachedEvents.push(event);
		}
	}

	// The session does not resolve before its events landed in the cache —
	// the ui's "cache-first" repeat-query guarantee depends on the flush.
	const pendingWrites: Promise<unknown>[] = [];
	const perRouteReceived = new Map<string, number>();
	let relays: RelayStatus[] = [];

	const onSlice = (slice: FetchSlice): void => {
		const rejectedBefore = invalidSkipped;
		perRouteReceived.set(slice.route ?? 'default', (perRouteReceived.get(slice.route ?? 'default') ?? 0) + slice.events.length);
		const skeletons: SkeletonCard[] = [];
		for (const event of slice.events) {
			if (admittedSet.has(event.id) || rejectedIds.has(event.id)) continue;
			const verdict = admit(event);
			if (!verdict.ok) {
				rejectedIds.add(event.id);
				invalidSkipped += 1;
				continue;
			}
			admittedSet.set(event.id, event);
			skeletons.push(skeletonOf(event));
			// Cache write settles by session end (pendingWrites below) — the
			// degrade contract stays silent per spec §6, and the next run's
			// cache-first read must see these events to honor '#28 repeat-query'.
			pendingWrites.push(indexEvent(event).catch(() => {}));
		}
		if (skeletons.length > 0) emit({ type: 'skeleton', cards: skeletons });
		// issue #36: per-slice admitted/rejected so the trace's Organize row
		// counts while fetching instead of only at 'done'.
		emit({
			type: 'slice',
			url: slice.url,
			received: slice.events.length,
			route: slice.route ?? 'default',
			// issue #36 review: the trace counts only ACTUALLY answered
			// relays; a refused leg is not a source (spec §3/§4 distinction).
			rejected: invalidSkipped - rejectedBefore,
			status: slice.status.status
		});
	};

	// Cache slice delivered as a real slice with route label 'cache',
	// so skeletons arrive ordering-correctly and TaskRows can say where
	// they came from. Duplicate events dedupe at page level.
	if (cachedEvents.length > 0) {
		notices.push({ kind: 'cache', message: `${cachedEvents.length} from local cache` });
		onSlice({
			url: 'local-cache',
			events: cachedEvents,
			status: { url: 'local-cache', status: 'ok', count: cachedEvents.length },
			route: 'cache'
		});
	}

	emit({ type: 'phase', phase: 'fetch' });

	// Tag legs fire BEFORE capability probes: they're NIP-01 — spec §7 wants
	// skeletons instantly and a hung probe must not hold them (review R2).
	const tagRoutes = searches.filter((s) => s.kind === 'tag').flatMap((search) => routeSearch(search, opts.relays, new Map(), []));
	if (tagRoutes.length > 0) {
		const tagResult = await opts.transport.fetchRouted(tagRoutes, onSlice);
		relays = tagResult.relays;
	}

	// Pure-tag questions need never probe NIP-11: tag filters are NIP-01, every
	// relay answers them. Freetext questions do — the only routing
	// decision (NIP-50 vs fullScanFilter) depends on the probe's hint.
	const freetextCount = searches.filter((s) => s.kind === 'text').length;
	const caps = new Map<string, RelayCapability>();
	if (freetextCount > 0) {
		await Promise.all(opts.relays.map(async (url) => caps.set(url, await opts.transport.capability(url))));
	}
	const routes = searches.filter((s) => s.kind === 'text').flatMap((search) => routeSearch(search, opts.relays, caps, notices));

	if (routes.length > 0) {
		// Progressive fetch: first-relayer-shared batch slices arrive in
		// completion order and skeletons paint at the FIRST relay's EOSE.
		const result = await opts.transport.fetchRouted(routes, onSlice);
		// Merge with any statuses the tag leg already reported (url-keyed —
		// a relay with legs in both lanes reports once, newest wins).
		const merged = new Map(relays.map((r) => [r.url, r]));
		for (const r of result.relays) merged.set(r.url, r);
		relays = [...merged.values()];
	}

	await Promise.all(pendingWrites);
	await truncationNotices(routes, perRouteReceived, opts.transport, notices);
	if (invalidSkipped > 0) {
		notices.push({ kind: 'invalid-skipped', message: `${invalidSkipped} invalid skipped` });
	}

	emit({ type: 'phase', phase: 'done' });
	for (const notice of notices) emit({ type: 'notice', notice });

	return {
		searches,
		admitted: [...admittedSet.values()],
		invalidSkipped,
		notices,
		relays
	};
}
