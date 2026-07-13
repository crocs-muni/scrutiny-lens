import NDK, { type NDKEvent, type NDKFilter as NDKSDKFilter } from '@nostr-dev-kit/ndk';
import { PUBLIC_RELAY_URL } from '$env/static/public';
import type { NostrEvent } from '$lib/session/types.js';
import type { FilterPlan } from '$lib/ai/types.js';
import { detectMode, searchFilter, TYPE_TAGS } from './modes.js';
import type { DetectedQuery } from './types.js';

const DEFAULT_RELAY_URL = 'ws://localhost:7777';
const CONNECT_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
const COUNT_TIMEOUT_MS = 4000;
const PRODUCT_FETCH_LIMIT = 60;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		})
	]);
}

function toNostrEvent(ndkEvent: NDKEvent): NostrEvent {
	const event = ndkEvent.rawEvent();
	return {
		id: event.id,
		sig: event.sig ?? '',
		pubkey: event.pubkey,
		created_at: event.created_at ?? 0,
		kind: event.kind ?? 1,
		tags: event.tags,
		content: event.content
	};
}

/**
 * Connects a fresh NDK client to the configured relay. Returns null if the
 * relay is unreachable or the connect attempt times out -- callers should
 * fall back to the demo fixture in that case.
 */
export async function connectRelay(): Promise<NDK | null> {
	const relayUrl = PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
	const ndk = new NDK({ explicitRelayUrls: [relayUrl] });
	try {
		await withTimeout(ndk.connect(CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS, 'relay connect');
		return ndk;
	} catch (err) {
		console.warn('[relay] connect failed, falling back to fixtures:', err);
		return null;
	}
}

export function disconnectRelay(ndk: NDK): void {
	for (const relay of ndk.pool.relays.values()) relay.disconnect();
}

/**
 * NIP-45 COUNT wrapper. The relay (khatru) reports exact counts for
 * tag-based filters (#i, #e, #t) but ignores NIP-50 `search` filters when
 * counting (verified empirically: COUNT with a `search` term returns the
 * same total as no filter at all). Callers must not rely on this for
 * freetext/browse queries -- use the fetched result size as a floor instead.
 */
export async function countEvents(ndk: NDK, filter: NDKSDKFilter): Promise<number> {
	try {
		const res = await withTimeout(
			ndk.count(filter, { timeout: COUNT_TIMEOUT_MS }),
			COUNT_TIMEOUT_MS,
			'relay count'
		);
		return res.count;
	} catch (err) {
		console.warn('[relay] count failed:', err);
		return 0;
	}
}

export interface ProductSearchResult {
	products: NostrEvent[];
	/** Certificates matching the query. Exact when identifier-scoped (COUNT), a floor (>= fetched size) otherwise. */
	matchedCount: number;
	/** True when matchedCount is a lower bound rather than an exact NIP-45 COUNT result. */
	matchedIsApprox: boolean;
	/** Total Product events on the relay, regardless of this query. */
	totalCount: number;
}

/**
 * Searches Product events on the relay for the current query/plan.
 * Prefers the AI-derived identifier (exact `#i` match, real NIP-45 COUNT)
 * and falls back to modes.ts's freetext/browse detection otherwise.
 */
export async function searchProducts(
	ndk: NDK,
	plan: FilterPlan,
	query: string
): Promise<ProductSearchResult> {
	const identifiers = plan.filters.filter((f) => f.identifier).map((f) => f.identifier!);
	const detected: DetectedQuery =
		identifiers.length > 0 ? { mode: 'identifier', identifier: identifiers[0] } : detectMode(query);

	const filter = searchFilter(detected, 'product') as NDKSDKFilter;
	if (identifiers.length > 1) (filter as { '#i'?: string[] })['#i'] = identifiers;

	const totalFilter: NDKSDKFilter = { kinds: [1], '#t': [TYPE_TAGS.product] };

	const [fetched, totalCount] = await Promise.all([
		withTimeout(
			ndk.fetchEvents({ ...filter, limit: PRODUCT_FETCH_LIMIT }),
			FETCH_TIMEOUT_MS,
			'relay product fetch'
		),
		countEvents(ndk, totalFilter)
	]);

	let products = Array.from(fetched).map(toNostrEvent);

	if (detected.mode === 'identifier') {
		let matchedCount = await countEvents(ndk, filter);

		// AI-derived identifiers aren't guaranteed to match relay tag casing
		// exactly (e.g. "vendor:infineon" vs the relay's "vendor:Infineon").
		// Fall back to a freetext search on the identifier's value so a
		// case/format mismatch doesn't silently produce zero real results.
		if (matchedCount === 0) {
			const value = detected.identifier!.split(':').slice(1).join(':') || detected.identifier!;
			const freetextFilter: NDKSDKFilter = { ...totalFilter, search: value };
			const freetextFetched = await withTimeout(
				ndk.fetchEvents({ ...freetextFilter, limit: PRODUCT_FETCH_LIMIT }),
				FETCH_TIMEOUT_MS,
				'relay product freetext fallback fetch'
			);
			products = Array.from(freetextFetched).map(toNostrEvent);
			return {
				products,
				matchedCount: products.length,
				matchedIsApprox: products.length >= PRODUCT_FETCH_LIMIT,
				totalCount
			};
		}

		return { products, matchedCount, matchedIsApprox: false, totalCount };
	}

	// freetext/browse: NIP-45 COUNT doesn't respect `search`, so the fetched
	// batch size is the best count we can show (a floor, not exact).
	return {
		products,
		matchedCount: products.length,
		matchedIsApprox: products.length >= PRODUCT_FETCH_LIMIT,
		totalCount
	};
}

/**
 * Total Binding events touching a Product or Metadata node, either direction
 * (as `root` or `link`) -- i.e. how many other nodes it's connected to on the
 * relay, regardless of how many of those are currently visible in a session
 * graph. Used to show the "+N" expand affordance's count before the user
 * clicks it.
 */
export async function countBindings(ndk: NDK, nodeId: string): Promise<number> {
	return countEvents(ndk, { kinds: [1], '#t': [TYPE_TAGS.binding], '#e': [nodeId] });
}

export interface ProductStats {
	boundMetadata: number;
	attachments: number;
	updates: number;
}

/**
 * Real per-product stats, computed from the graph around a Product event:
 *  - boundMetadata: NIP-45 COUNT of Binding events whose `e` tags reference this product.
 *  - attachments: `imeta` tags across the Metadata events those bindings link to.
 *  - updates: NIP-45 COUNT of Patch events referencing this product.
 */
export async function getProductStats(ndk: NDK, productId: string): Promise<ProductStats> {
	const bindingFilter: NDKSDKFilter = { kinds: [1], '#t': [TYPE_TAGS.binding], '#e': [productId] };
	const patchFilter: NDKSDKFilter = { kinds: [1], '#t': [TYPE_TAGS.patch], '#e': [productId] };

	const [boundMetadata, updates, bindings] = await Promise.all([
		countEvents(ndk, bindingFilter),
		countEvents(ndk, patchFilter),
		withTimeout(
			ndk.fetchEvents({ ...bindingFilter, limit: 100 }),
			FETCH_TIMEOUT_MS,
			'relay bindings fetch'
		)
	]);

	const metadataIds = new Set<string>();
	for (const binding of bindings) {
		for (const tag of binding.rawEvent().tags) {
			if (tag[0] === 'e' && tag[1] && tag[1] !== productId) metadataIds.add(tag[1]);
		}
	}

	let attachments = 0;
	if (metadataIds.size > 0) {
		const metas = await withTimeout(
			ndk.fetchEvents({ ids: Array.from(metadataIds) }),
			FETCH_TIMEOUT_MS,
			'relay metadata fetch'
		);
		for (const meta of metas) {
			attachments += meta.rawEvent().tags.filter((t) => t[0] === 'imeta').length;
		}
	}

	return { boundMetadata, attachments, updates };
}

export interface FacetCount {
	value: string;
	count: number;
}

export interface FacetBreakdown {
	scheme: FacetCount[];
	eal: FacetCount[];
	status: FacetCount[];
}

const EAL_RE = /EAL\d\+?/;
const STATUS_RE = /Status:\s*(Active|Archived)/i;

/**
 * Facet counts derived client-side from the fetched Product events -- i.e.
 * scoped to the current query's (loaded) result set, not the whole relay.
 * Scheme comes from the `i` tag (`scheme:XX`); EAL and status aren't tagged
 * on this relay's Product events, so they're parsed from the event content
 * (e.g. "Certified under scheme DE at EAL3+." / "Status: archived.").
 */
export function computeFacets(products: NostrEvent[]): FacetBreakdown {
	const scheme = new Map<string, number>();
	const eal = new Map<string, number>();
	const status = new Map<string, number>();

	for (const product of products) {
		for (const tag of product.tags) {
			if (tag[0] === 'i' && tag[1].startsWith('scheme:')) {
				const value = tag[1].slice('scheme:'.length);
				scheme.set(value, (scheme.get(value) ?? 0) + 1);
			}
		}
		const ealMatch = product.content.match(EAL_RE);
		if (ealMatch) eal.set(ealMatch[0], (eal.get(ealMatch[0]) ?? 0) + 1);
		const statusMatch = product.content.match(STATUS_RE);
		if (statusMatch) {
			const value = statusMatch[1][0].toUpperCase() + statusMatch[1].slice(1).toLowerCase();
			status.set(value, (status.get(value) ?? 0) + 1);
		}
	}

	const toSorted = (m: Map<string, number>): FacetCount[] =>
		Array.from(m, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);

	return {
		scheme: toSorted(scheme).slice(0, 6),
		eal: toSorted(eal).slice(0, 6),
		status: toSorted(status)
	};
}
