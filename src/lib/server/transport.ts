/**
 * SCRUTINY Lens v2 — Nostr relay transport (wave W1).
 *
 * Server-only module: `nostr-tools` must NEVER be imported outside src/lib/server/**
 * so the client bundle stays free of websocket/relay code.
 *
 * ── C2 verification: actual nostr-tools 2.25.0 API surface ─────────────────────
 * Verified against node_modules/nostr-tools/lib/types/*.d.ts and lib/esm/*.js:
 *
 * - Pool creation: `SimplePool` from 'nostr-tools/pool' (extends `AbstractSimplePool`
 *   from 'nostr-tools/abstract-pool'). Constructor takes
 *   `Pick<AbstractPoolConstructorOptions, 'enablePing' | 'enableReconnect'>`.
 *   There is NO per-url pool constructor — relays are attached lazily per call.
 *
 * - Per-relay abstraction: `AbstractRelay` (from 'nostr-tools/abstract-relay';
 *   `Relay` from 'nostr-tools/relay' only adds `.connect()` sugar). The pool hands
 *   out relays via `pool.ensureRelay(url, { connectionTimeout?, abort? })`
 *   → `Promise<AbstractRelay>`; the promise REJECTS on connection failure
 *   (see lib/esm/abstract-pool.js L723+). We call it per url so each relay gets
 *   its own independent connect timeout.
 *
 * - One-shot fetch returning events after EOSE: `pool.querySync(urls, filter, { maxWait? })`
 *   → `Promise<NostrEvent[]>`. Verified in lib/esm/abstract-pool.js L905-918: it
 *   wraps `subscribeEose` and resolves with all events once the subscription(s)
 *   close after EOSE (or maxWait). NOTE: it takes ONE filter and does not exist
 *   per-relay (`relay.fetchEventOnce`/`fetchAllEvents` do NOT exist in 2.25) —
 *   so we fan out by calling `querySync([url], filter)` once per relay, which
 *   also isolates per-relay failures.
 *
 * - NIP-45 COUNT: relays expose it directly as `relay.count(filters, { id? })`
 *   → `Promise<number>` (lib/esm/abstract-relay.js L391-401 sends
 *   `["COUNT", id, ...filters]`); `countWithHLL` is the HLL variant.
 *   `pool.countMany()` is NOT general counting — it only supports the fixed
 *   CountManyDirective set ('reactions'|'reposts'|'quotes'|'replies'|'comments'|'followers'),
 *   so it is not used here.
 *
 * - Closing: `relay.close()` per relay; the pool also offers `pool.close(urls)` and
 *   `pool.destroy()`. We track relays we obtained from `ensureRelay` and close each
 *   exactly once, then `destroy()` the pool to sweep anything untracked.
 *
 * - Types: `NostrEvent` from 'nostr-tools/core' (id/sig/pubkey/created_at/kind/tags/content);
 *   `Filter` + `mergeFilters` from 'nostr-tools/filter'.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/core';
import { mergeFilters, type Filter } from 'nostr-tools/filter';

/** Per-relay connect timeout (ms). Each relay connects independently. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Per-relay fetch timeout (ms): max wait for events after EOSE. */
export const FETCH_TIMEOUT_MS = 8_000;
/** Per-relay NIP-45 COUNT timeout (ms). */
export const COUNT_TIMEOUT_MS = 3_000;

export type RelayState = 'ok' | 'timeout' | 'refused';

export interface RelayStatus {
	url: string;
	status: RelayState;
	/** Fetch: number of events this relay returned. Count: this relay's COUNT. 0 on failure. */
	count: number;
	lastError?: string;
}

export interface FetchResult {
	/** Merged events, deduplicated by event.id (first occurrence wins, in relay order). */
	events: NostrEvent[];
	/** One entry per configured relay, in configured order. */
	relays: RelayStatus[];
}

export interface CountResult {
	/** Sum of COUNT responses across relays with status 'ok'. */
	total: number;
	relays: RelayStatus[];
}

export interface Transport {
	fetch(filters: Filter[]): Promise<FetchResult>;
	count(filters: Filter[]): Promise<CountResult>;
	close(): Promise<void>;
}

/**
 * Minimal pool surface used by the transport. Structurally satisfied by
 * nostr-tools `AbstractSimplePool`; tests inject a fake instead.
 */
export interface RelayLike {
	count(filters: Filter[], params?: { id?: string | null }): Promise<number>;
	close(): void;
}

export interface PoolLike {
	ensureRelay(url: string, params?: { connectionTimeout?: number }): Promise<RelayLike>;
	querySync(urls: string[], filter: Filter, params?: { maxWait?: number }): Promise<NostrEvent[]>;
	/** Present on AbstractSimplePool; optional so fakes may omit it. */
	destroy?(): void;
}

export type PoolFactory = () => PoolLike;

/** Rejects after `ms` with an error tagged with the relay url and operation. */
class TransportTimeoutError extends Error {
	constructor(
		readonly url: string,
		readonly tag: string,
		readonly ms: number
	) {
		super(`${tag} timed out after ${ms}ms (relay ${url})`);
		this.name = 'TransportTimeoutError';
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, url: string, tag: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new TransportTimeoutError(url, tag, ms)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class RelayTransport implements Transport {
	private readonly pool: PoolLike;
	/** Relays successfully obtained from ensureRelay, keyed by configured url. */
	private readonly relays = new Map<string, RelayLike>();
	private closed = false;

	constructor(
		private readonly urls: string[],
		poolFactory: PoolFactory
	) {
		if (urls.length === 0) throw new Error('transport needs at least one relay url');
		this.pool = poolFactory();
	}

	private async ensure(url: string): Promise<RelayLike> {
		const cached = this.relays.get(url);
		if (cached) return cached;
		const relay = await this.pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
		this.relays.set(url, relay);
		return relay;
	}

	private async runPerRelay<T>(
		tag: 'fetch' | 'count',
		timeoutMs: number,
		run: (url: string, relay: RelayLike) => Promise<{ count: number; value: T }>
	): Promise<{ statuses: RelayStatus[]; ok: { url: string; value: T }[] }> {
		const settled = await Promise.all(
			this.urls.map(async (url) => {
				try {
					const relay = await withTimeout(
						this.ensure(url),
						CONNECT_TIMEOUT_MS,
						url,
						'connect'
					);
					const { count, value } = await withTimeout(
						run(url, relay),
						timeoutMs,
						url,
						tag
					);
					return { status: { url, status: 'ok' as const, count }, ok: { url, value } };
				} catch (error) {
					const timedOut = error instanceof TransportTimeoutError;
					return {
						status: {
							url,
							status: timedOut ? ('timeout' as const) : ('refused' as const),
							count: 0,
							lastError: errorMessage(error)
						},
						ok: null
					};
				}
			})
		);
		return {
			statuses: settled.map((s) => s.status),
			ok: settled.flatMap((s) => (s.ok ? [s.ok] : []))
		};
	}

	async fetch(filters: Filter[]): Promise<FetchResult> {
		// querySync takes a single filter (verified: nostr-tools 2.25 signature);
		// multiple filters are merged with nostr-tools' own mergeFilters.
		const filter = filters.length > 1 ? mergeFilters(...filters) : (filters[0] ?? {});
		const { statuses, ok } = await this.runPerRelay(
			'fetch',
			FETCH_TIMEOUT_MS,
			async (url) => {
				const events = await this.pool.querySync([url], filter, {
					maxWait: FETCH_TIMEOUT_MS
				});
				return { count: events.length, value: events };
			}
		);
		// Merge + dedupe by event.id, keeping the FIRST occurrence (relay config order).
		const seen = new Set<string>();
		const events: NostrEvent[] = [];
		for (const { value } of ok) {
			for (const event of value) {
				if (seen.has(event.id)) continue;
				seen.add(event.id);
				events.push(event);
			}
		}
		return { events, relays: statuses };
	}

	async count(filters: Filter[]): Promise<CountResult> {
		const { statuses } = await this.runPerRelay(
			'count',
			COUNT_TIMEOUT_MS,
			async (_url, relay) => {
				const count = await relay.count(filters, { id: null });
				return { count, value: count };
			}
		);
		// Multi-relay COUNT is only a best-effort union estimate: relays overlap in
		// what they store, so summing counts across 'ok' relays over-counts shared
		// events. It is still the most useful single number for "how big is this
		// result set" UI hints; document it as an estimate, not an exact union.
		const total = statuses.reduce((sum, s) => (s.status === 'ok' ? sum + s.count : sum), 0);
				return { total, relays: statuses };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// Close each relay we obtained exactly once, then destroy the pool.
		const relays = [...this.relays.values()];
		this.relays.clear();
		for (const relay of relays) relay.close();
		this.pool.destroy?.();
	}
}

/**
 * Default pool: a real nostr-tools SimplePool. `enableReconnect: false` because
 * reconnection policy belongs to the caller (a failed relay is reported
 * 'refused'/'timeout' and the UI decides whether to retry), and reconnect timers
 * would keep handles alive in the server process.
 */
const defaultPoolFactory: PoolFactory = () => new SimplePool({ enableReconnect: false });

export function createTransport(
	options: { urls: string[] },
	poolFactory: PoolFactory = defaultPoolFactory
): Transport {
	return new RelayTransport(options.urls, poolFactory);
}
