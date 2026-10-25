// Publisher kind-0 profile seam (issue #38, spec §9 P3 anatomy; kind-0 =
// NIP-01). Resolves a pubkey to the feed-display name + picture a result
// surface presents. Kind-0 content is free-form JSON per NIP-01, so it is
// parsed defensively and any failure resolves null — the chip then shows an
// honest "no kind-0 profile on your relays" state instead of fabricating one.
//
// Relay I/O is nostr-tools ONLY (AGENTS.md hard rule). The pool idiom is the
// transport's: one-shot querySync bounded by maxWait, and destroy() to sweep
// every opened relay once the query settles, so websockets can't leak. The
// settings singleton is read at call time (dynamic import, in getProfile) so
// the publisher chip stays presentational — it never imports settings.
//
// Pool-scoped truth (issue #131 WP7, spec §2 never-lie): the answer belongs to
// the pool that produced it. A miss earned while the relay list was empty,
// being edited, or dead is NOT evidence about a different pool, so the pool is
// part of the cache key instead of ambient state — otherwise the chip replays
// "no kind-0 profile on your relays" under relays that were never asked.

import { SimplePool } from 'nostr-tools/pool';

export interface PublisherProfile {
	name: string | null;
	picture: string | null;
}

/** Three-state result: an object was found, null means the pool was asked and
 * no relay held a kind-0 event, undefined means NOTHING WAS ASKED (empty pool)
 * — the chip may claim nothing at all in that case. */
export type ProfileLookup = PublisherProfile | null | undefined;

/** What a settled lookup licenses the chip to say (spec §2 never-lie). */
export type ProfileClaim = 'found' | 'missing' | 'unasked';

/** Settled profile cache — a pubkey asked twice under one pool pays zero
 * relays. Keyed by pool fingerprint (see lookupKey). */
const cache = new Map<string, PublisherProfile | null>();
/** Misses are cached only briefly — a cold-start failure (relay list being
 * edited, relay warming) must NOT freeze the identicon for the tab's whole
 * lifetime (review finding). */
const misses = new Map<string, number>();
/** In-flight dedupe — concurrent callers of one pool+pubkey share one fetch. */
const inflight = new Map<string, Promise<ProfileLookup>>();

/** Hard cap on the whole query (connect + EOSE) per pubkey; ≥ the first
 * handshake window so a fresh relay isn't judged before it connects. */
const PROFILE_TIMEOUT_MS = 3_000;
/** How long a "no profile" miss is trusted before retrying. */
const MISS_TTL_MS = 120_000;

/* ×4-pubkey parallelism cap: N interpreted cards mounting together would
 * otherwise open N pools × up to 4 relay websockets at once and trip the
 * browser's per-host socket budget (review finding). */
const MAX_PARALLEL = 4;
let active = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
	if (active < MAX_PARALLEL) {
		active += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
	active -= 1;
	queue.shift()?.();
}

/** Cache key = trusted pool + pubkey. The fingerprint is the joined relay
 * list: a hit or a miss is only ever replayed under the relays that earned it
 * (issue #131 WP7). Deliberately order-sensitive — a reordered list is a
 * different pool object as far as trust goes, and re-querying is cheap. */
function lookupKey(pool: readonly string[], pubkey: string): string {
	return `${pool.join('\n')}|${pubkey}`;
}

/** The chip's honest claim for a settled lookup — pure so the mapping is
 * testable without mounting the component (node test env has no DOM). */
export function profileClaim(lookup: ProfileLookup): ProfileClaim {
	if (lookup === undefined) return 'unasked';
	return lookup === null ? 'missing' : 'found';
}

/**
 * Resolves a pubkey against the LIVE relay pool. Awaits the boot barrier
 * first: a chip mounting before hydration would otherwise query the
 * pre-hydration default relays and cache that answer under relays the user
 * never chose (issue #131 WP7). ready() is single-flight and free after boot.
 */
export async function getProfile(pubkey: string): Promise<ProfileLookup> {
	// Settings read at call time so this seam follows the live relay pool.
	// Dynamic import REQUIRED (ts-no-dynamic-import exception): this net seam
	// must not make the presentational chip pull the settings singleton as a
	// hard module-load dependency — spec §9 wires nothing in components; the
	// page owns the singleton.
	const { settings } = await import('$lib/settings.svelte');
	await settings.ready();
	// Snapshot the hydrated pool: the key and the query must name the same
	// relays even if the user edits the list mid-flight.
	return queryProfile(pubkey, [...settings.relays]);
}

/**
 * Pool-scoped resolve. An empty pool asks nothing and therefore answers
 * undefined (never a miss: "no profile" is a claim about relays, and there
 * are none). Everything else is served from the pool-keyed cache, the
 * short-lived miss table, or one shared fresh query.
 */
function queryProfile(pubkey: string, pool: readonly string[]): Promise<ProfileLookup> {
	if (pool.length === 0) return Promise.resolve(undefined);

	const key = lookupKey(pool, pubkey);
	const hit = cache.get(key);
	if (hit !== undefined) return Promise.resolve(hit);
	const missedAt = misses.get(key);
	if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return Promise.resolve(null);

	const pending = inflight.get(key);
	if (pending) return pending;

	const fetch = (async () => {
		await acquire();
		try {
			const profile = await fetchProfile(pubkey, pool);
			if (profile === null) misses.set(key, Date.now());
			else {
				cache.set(key, profile);
				misses.delete(key);
			}
			return profile;
		} finally {
			release();
		}
	})().finally(() => inflight.delete(key));
	inflight.set(key, fetch);
	return fetch;
}

/**
 * Raw relay read against exactly the given relays. Resolves null on ANY
 * failure (all relays refused / timed out, malformed JSON) — never throws, so
 * the component's fallback is always honest.
 */
async function fetchProfile(
	pubkey: string,
	relays: readonly string[]
): Promise<PublisherProfile | null> {
	const client = new SimplePool({ enableReconnect: false });
	try {
		// querySync's maxWait bounds the whole query and resolves [] on timeout.
		const events = await client.querySync(
			[...relays],
			{ kinds: [0], authors: [pubkey], limit: 1 },
			{ maxWait: PROFILE_TIMEOUT_MS }
		);
		return events.length > 0 ? parseProfile(events[0].content) : null;
	} catch {
		// All relays refused or timed out — treat as no profile.
		return null;
	} finally {
		client.destroy();
	}
}

/** Best-effort kind-0 parse: NIP-01 content is free-form JSON, never trusted. */
function parseProfile(content: string): PublisherProfile | null {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

		const name = pickString(parsed.name) ?? pickString(parsed.display_name) ?? null;
		const picture = pickString(parsed.picture) ?? null;
		// An event with neither field carries nothing worth surfacing.
		if (name === null && picture === null) return null;
		return { name, picture };
	} catch {
		return null;
	}
}

/** Non-empty string field, else undefined — tolerates non-string JSON values. */
function pickString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Test seam — same shape as resetInvestigation: clears the pool-keyed settled
 * cache, the miss table and any in-flight dedupe so a spec file starts from
 * zero relays.
 */
export function resetProfiles(): void {
	cache.clear();
	inflight.clear();

	misses.clear();
}
