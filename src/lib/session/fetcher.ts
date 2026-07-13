import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';
import { PUBLIC_RELAY_URL } from '$env/static/public';
import type { NostrEvent, Session } from './types.js';
import demo from '../../../fixtures/demo-graph.json' with { type: 'json' };

const DEFAULT_RELAY_URL = 'ws://localhost:7777';
const CONNECT_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
const FETCH_LIMIT = 1000;

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

const isBinding = (event: NostrEvent): boolean =>
	event.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-binding');

/**
 * Fetches exactly one node's immediate neighborhood: every Binding, Patch, and
 * Deletion event that directly references `nodeId`, plus -- for each Binding
 * found -- the actual Product/Metadata content on the *other* end of that
 * edge. Deliberately does not recurse: a shared Metadata node (e.g. a common
 * SAR component bound to many unrelated certificates) stops here instead of
 * pulling in every other product that happens to share it. Recursing further
 * is the user's call, one node at a time, via the expand affordance.
 */
export async function fetchNodeNeighbors(ndk: NDK, nodeId: string): Promise<NostrEvent[]> {
	const touching = await withTimeout(
		ndk.fetchEvents({ '#e': [nodeId], limit: FETCH_LIMIT }),
		FETCH_TIMEOUT_MS,
		'relay neighbor fetch'
	);
	const touchingEvents = Array.from(touching).map(toNostrEvent);

	const otherIds = new Set<string>();
	for (const event of touchingEvents) {
		if (!isBinding(event)) continue;
		for (const tag of event.tags) {
			if (tag[0] === 'e' && tag[1] && tag[1] !== nodeId) otherIds.add(tag[1]);
		}
	}

	if (otherIds.size === 0) return touchingEvents;

	const others = await withTimeout(
		ndk.fetchEvents({ ids: Array.from(otherIds) }),
		FETCH_TIMEOUT_MS,
		'relay neighbor content fetch'
	);
	return [...touchingEvents, ...Array.from(others).map(toNostrEvent)];
}

/**
 * Fetches a session's base view: the root event's own immediate neighborhood
 * (see fetchNodeNeighbors). Falls back to the synthetic demo fixture if the
 * relay is unreachable, times out, or returns nothing.
 */
export async function fetchSessionEvents(session: Session): Promise<NostrEvent[]> {
	if (!session.rootEventId) return demo.events as NostrEvent[];

	const relayUrl = PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
	const ndk = new NDK({ explicitRelayUrls: [relayUrl] });

	try {
		await withTimeout(ndk.connect(CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS, 'relay connect');
		const neighbors = await fetchNodeNeighbors(ndk, session.rootEventId);
		if (neighbors.length === 0) return demo.events as NostrEvent[];
		return neighbors;
	} catch (err) {
		// MVP fallback: relay unreachable, slow, or empty for this session -> synthetic demo graph.
		console.warn('[fetchSessionEvents] relay fetch failed, falling back to fixtures:', err);
		return demo.events as NostrEvent[];
	} finally {
		for (const relay of ndk.pool.relays.values()) relay.disconnect();
	}
}

/**
 * Expands a single node on demand (the "+" affordance): connects fresh, fetches
 * that node's immediate neighborhood, disconnects. Unlike fetchSessionEvents,
 * this does not fall back to the demo fixture on failure -- a relay hiccup
 * during an on-demand expand should surface as an error, not silently inject
 * unrelated synthetic data into a real session.
 */
export async function expandNodeNeighbors(nodeId: string): Promise<NostrEvent[]> {
	const relayUrl = PUBLIC_RELAY_URL || DEFAULT_RELAY_URL;
	const ndk = new NDK({ explicitRelayUrls: [relayUrl] });
	try {
		await withTimeout(ndk.connect(CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS, 'relay connect');
		return await fetchNodeNeighbors(ndk, nodeId);
	} finally {
		for (const relay of ndk.pool.relays.values()) relay.disconnect();
	}
}
