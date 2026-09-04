// Publisher kind-0 profile seam (issue #38, spec §9 P3 anatomy; kind-0 =
// NIP-01). Resolves a pubkey to the feed-display name + picture a result
// surface presents. Kind-0 content is free-form JSON per NIP-01, so it is
// parsed defensively and any failure resolves null — the chip then shows an
// honest "no kind-0 profile on your relays" state instead of fabricating one.
//
// Relay I/O is nostr-tools ONLY (AGENTS.md hard rule). The pool idiom is the
// transport's: one-shot querySync bounded by maxWait, and destroy() to sweep
// every opened relay once the query settles, so websockets can't leak. This
// seam reads settings at call time (dynamic import) so the publisher chip
// stays presentational — it never imports the settings singleton.

import { SimplePool } from 'nostr-tools/pool';

export interface PublisherProfile {
	name: string | null;
	picture: string | null;
}

/** Settled profile cache — a pubkey asked twice pays zero relays. */
const cache = new Map<string, PublisherProfile | null>();
/** In-flight dedupe — concurrent callers of one pubkey share a single fetch. */
const inflight = new Map<string, Promise<PublisherProfile | null>>();

/** Hard cap on the whole query (connect + EOSE) per pubkey. */
const PROFILE_TIMEOUT_MS = 1_500;

export function getProfile(pubkey: string): Promise<PublisherProfile | null> {
	const cached = cache.get(pubkey);
	if (cached !== undefined) return Promise.resolve(cached);

	const pending = inflight.get(pubkey);
	if (pending) return pending;

	const fetch = queryProfile(pubkey).finally(() => inflight.delete(pubkey));
	inflight.set(pubkey, fetch);
	return fetch;
}

/**
 * Resolves null on ANY failure (all relays refused / timed out, malformed
 * JSON) — never throws, so the component's fallback is always honest.
 */
async function queryProfile(pubkey: string): Promise<PublisherProfile | null> {
	const pool = new SimplePool({ enableReconnect: false });
	try {
		// Settings read at call time so this seam follows the live relay pool.
		// Dynamic import REQUIRED (ts-no-dynamic-import exception): this net seam
		// must not make the presentational chip pull the settings singleton as a
		// hard module-load dependency — spec §9 wires nothing in components; the
		// page owns the singleton.
		const { settings } = await import('$lib/settings.svelte');
		// querySync's maxWait bounds the whole query and resolves [] on timeout.
		const events = await pool.querySync(
			settings.relays,
			{ kinds: [0], authors: [pubkey], limit: 1 },
			{ maxWait: PROFILE_TIMEOUT_MS }
		);
		return events.length > 0 ? parseProfile(events[0].content) : null;
	} catch {
		// All relays refused or timed out — treat as no profile.
		return null;
	} finally {
		pool.destroy();
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
 * Test seam — same shape as resetInvestigation: clears both the settled
 * cache and any in-flight dedupe so a spec file starts from zero relays.
 */
export function resetProfiles(): void {
	cache.clear();
	inflight.clear();
}
