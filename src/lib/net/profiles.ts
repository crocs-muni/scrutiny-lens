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
//
// Local-first for HITS (issue #135, spec §6): a kind-0 this device already
// resolved is local data, so it answers before any relay is asked. Cache-
// restored cards (a reload rebuilds the surface from IndexedDB, #83) used to
// mount every chip at once and re-ask for every publisher; the relay burst
// timed out and the cards sat bare even though the identity had resolved
// minutes earlier. A stored row is a fact about the AUTHOR (a signed kind-0
// this device saw), not a claim about the current relays — only the miss
// ("no kind-0 on your relays") stays pool-scoped.

import { SimplePool } from 'nostr-tools/pool';
import { loadProfile, saveProfile } from '$lib/db';

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

/** In-tab memo — a pubkey asked twice under one pool pays zero work. Keyed by
 * pool fingerprint (see lookupKey); the device's cross-reload rows live in
 * IndexedDB instead (loadProfile/saveProfile, issue #135). */
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
/** How long a device snapshot is treated as current (issue #135). NIP-01
 * kind-0 is replaceable, so a row is what the author published when we last
 * looked — never "the author's current name". Past this window the row still
 * paints (never a blank chip) but the relays are asked again, so a rename
 * reaches the reader instead of sticking until "Clear all local data". */
const PROFILE_ROW_TTL_MS = 24 * 60 * 60 * 1000;

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
export async function getProfile(
	pubkey: string,
	options: { refresh?: boolean } = {}
): Promise<ProfileLookup> {
	// Settings read at call time so this seam follows the live relay pool.
	// Dynamic import REQUIRED (ts-no-dynamic-import exception): this net seam
	// must not make the presentational chip pull the settings singleton as a
	// hard module-load dependency — spec §9 wires nothing in components; the
	// page owns the singleton.
	const { settings } = await import('$lib/settings.svelte');
	await settings.ready();
	// Snapshot the hydrated pool: the key and the query must name the same
	// relays even if the user edits the list mid-flight.
	const pool = [...settings.relays];
	// A refresh is an explicit "look again" gesture (trust editor click or a
	// relay-pool edit): bypass the memo, the 24h current-row gate, and the
	// short miss window. Normal callers keep the local-first path.
	return options.refresh === true ? refreshProfile(pubkey, pool) : queryProfile(pubkey, pool);
}

/**
 * Pool-scoped resolve. An empty pool asks nothing and therefore answers
 * undefined (never a miss: "no profile" is a claim about relays, and there
 * are none). Everything else is served from the pool-keyed memo, then the
 * device's stored snapshot (issue #135), the short-lived miss table, or one
 * shared fresh query.
 */
async function queryProfile(pubkey: string, pool: readonly string[]): Promise<ProfileLookup> {
	if (pool.length === 0) return Promise.resolve(undefined);

	const key = lookupKey(pool, pubkey);
	const hit = cache.get(key);
	if (hit !== undefined) return hit;

	// Device snapshot BEFORE any pool-scoped gate (issue #135): restoring a
	// session mounts a card per admitted product at once, and a relaunch has no
	// memo to answer them. A row is a fact about the AUTHOR, while a miss is a
	// fact about the relays — so the row is read before the miss window, and a
	// pool the user edited away and back cannot shadow it.
	const stored = await loadProfile(pubkey);
	// A row with neither field carries nothing worth surfacing — same rule
	// parseProfile applies to a relay read, so a stored blank can never make
	// the chip claim 'found' over an empty cell (spec §2 never-lie).
	const storedProfile: PublisherProfile | null =
		stored !== null && (stored.name !== null || stored.picture !== null)
			? { name: stored.name, picture: stored.picture }
			: null;
	const current =
		storedProfile !== null && stored !== null && Date.now() - stored.at < PROFILE_ROW_TTL_MS;
	if (current) {
		cache.set(key, storedProfile);
		return storedProfile;
	}

	const missedAt = misses.get(key);
	if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) {
		// A recent miss under this pool answers — but a stale device row paints
		// rather than leaving the chip blank.
		if (storedProfile !== null) cache.set(key, storedProfile);
		return storedProfile;
	}

	const pending = inflight.get(key);
	if (pending) return pending;

	const fetch = fetchAndStore(pubkey, pool, key, storedProfile).finally(() => inflight.delete(key));
	inflight.set(key, fetch);
	return fetch;
}

/**
 * Force one relay read, bypassing the pool memo, the device snapshot's
 * "current" gate, and the short miss window. The trust editor calls this when
 * the user clicks a key or edits the relay pool: both are explicit "look
 * again" gestures, and a renamed author must replace the stale name. A failed
 * read still paints the last known snapshot — never a blank identity, and
 * never a "missing" claim caused by a dead relay.
 */
async function refreshProfile(pubkey: string, pool: readonly string[]): Promise<ProfileLookup> {
	if (pool.length === 0) return Promise.resolve(undefined);
	const key = lookupKey(pool, pubkey);
	const pending = inflight.get(key);
	if (pending) return pending;

	// The stored row is a fallback, not a gate.
	const stored = await loadProfile(pubkey);
	const fallback: PublisherProfile | null =
		stored !== null && (stored.name !== null || stored.picture !== null)
			? { name: stored.name, picture: stored.picture }
			: null;

	const fetch = fetchAndStore(pubkey, pool, key, fallback).finally(() => inflight.delete(key));
	inflight.set(key, fetch);
	return fetch;
}

/** One shared relay read: cache the hit, record the miss, save the device row.
 * `fallback` is the last known identity a failed read may paint. */
async function fetchAndStore(
	pubkey: string,
	pool: readonly string[],
	key: string,
	fallback: PublisherProfile | null
): Promise<ProfileLookup> {
	await acquire();
	try {
		const profile = await fetchProfile(pubkey, pool);
		if (profile === null) {
			misses.set(key, Date.now());
			// A relay that has forgotten the author does not erase what this
			// device saw: paint the stale snapshot, still ask again later.
			if (fallback !== null) {
				cache.set(key, fallback);
				return fallback;
			}
			return null;
		}
		cache.set(key, profile);
		misses.delete(key);
		// Fire-and-forget, like every write-through in this app: the chip
		// paints from `profile` either way, and a lost row only costs one
		// relay query on the next load (spec §6 degrade).
		void saveProfile({ pubkey, ...profile, at: Date.now() });
		return profile;
	} finally {
		release();
	}
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
 * zero relays. Device rows are NOT touched (that is clearAllLocalData): a
 * reload is exactly the case this seam simulates, and the whole point of the
 * #135 local-first read is that the stored snapshots survive it.
 */
export function resetProfiles(): void {
	cache.clear();
	inflight.clear();

	misses.clear();
}
