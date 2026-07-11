import NDK, { NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk';
import { PUBLIC_RELAY_URL } from '$env/static/public';
import type { NostrEvent, Session } from './types.js';
import demo from '../../../fixtures/demo-graph.json' with { type: 'json' };

const DEFAULT_RELAY_URL = 'ws://localhost:7777';
const CONNECT_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
// Product -> Binding -> Metadata -> Patch -> Deletion is 4 edges; one extra hop
// ensures the last-discovered node's own content is actually fetched.
const MAX_HOPS = 5;
const HOP_LIMIT = 200;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		})
	]);
}

function toNostrEvent(event: NDKEvent): NostrEvent {
	const raw = event.rawEvent();
	return {
		id: raw.id,
		sig: raw.sig ?? '',
		pubkey: raw.pubkey,
		created_at: raw.created_at ?? 0,
		kind: raw.kind ?? 1,
		tags: raw.tags,
		content: raw.content
	};
}

/**
 * Walks the event graph outward from a set of seed ids in both directions:
 *  - incoming: events whose `e` tags reference a frontier id (e.g. a Binding
 *    references its Product; a Patch or Deletion may reference a Metadata event)
 *  - outgoing: ids that a frontier event's own `e` tags point at (e.g. a
 *    Binding's `e` tags point at both its Product and its Metadata event)
 * This is required because Products and Metadata never reference each other
 * directly -- only the Binding in between carries both edges.
 */
async function resolveGraph(ndk: NDK, seedIds: string[]): Promise<NostrEvent[]> {
	const events = new Map<string, NostrEvent>();
	const known = new Set(seedIds);
	let frontier = seedIds;

	for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
		const filters: NDKFilter[] = [
			{ ids: frontier, limit: HOP_LIMIT },
			{ '#e': frontier, limit: HOP_LIMIT }
		];
		const [idsResult, refResult] = await Promise.all(
			filters.map((filter) => ndk.fetchEvents(filter))
		);

		const nextFrontier: string[] = [];
		const addNew = (id: string) => {
			if (!known.has(id)) {
				known.add(id);
				nextFrontier.push(id);
			}
		};

		// Frontier events themselves: record them, and follow their outgoing e-tags.
		for (const ndkEvent of idsResult) {
			const event = toNostrEvent(ndkEvent);
			if (!events.has(event.id)) events.set(event.id, event);
			for (const tag of event.tags) {
				if (tag[0] === 'e' && tag[1]) addNew(tag[1]);
			}
		}
		// Events that reference the frontier (incoming edges).
		for (const ndkEvent of refResult) {
			const event = toNostrEvent(ndkEvent);
			if (!events.has(event.id)) events.set(event.id, event);
			addNew(event.id);
		}

		frontier = nextFrontier;
	}

	return Array.from(events.values());
}

/**
 * Fetches the events belonging to a session from the configured relay, starting
 * from the session's root event and any already-known related events, then
 * resolving the graph outward (see resolveGraph). Falls back to the synthetic
 * demo fixture if the relay is unreachable, times out, or returns nothing.
 */
export async function fetchSessionEvents(session: Session): Promise<NostrEvent[]> {
	const seedIds = Array.from(new Set([session.rootEventId, ...session.relatedEventIds])).filter(
		Boolean
	);
	if (seedIds.length === 0) return demo.events as NostrEvent[];

	const relayUrl = PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
	const ndk = new NDK({ explicitRelayUrls: [relayUrl] });

	try {
		await withTimeout(ndk.connect(CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS, 'relay connect');
		const events = await withTimeout(resolveGraph(ndk, seedIds), FETCH_TIMEOUT_MS, 'relay fetch');
		if (events.length === 0) return demo.events as NostrEvent[];
		return events;
	} catch (err) {
		// MVP fallback: relay unreachable, slow, or empty for this session -> synthetic demo graph.
		console.warn('[fetchSessionEvents] relay fetch failed, falling back to fixtures:', err);
		return demo.events as NostrEvent[];
	} finally {
		for (const relay of ndk.pool.relays.values()) relay.disconnect();
	}
}
