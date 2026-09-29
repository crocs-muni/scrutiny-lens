// Early fill leg + merge-over at settle (issue #118): start() assembles the
// PRE-context cohort and starts the fill lane BEFORE the §8.2 settle
// traversal — cards begin interpreting while the traversal still runs, and
// the post-traversal merge overlays the contextual full set without
// disturbing a lane's claimed positions. These tests drive the REAL start()
// (no _fillInChunksForTests): the transport is a scripted stub whose
// traversal legs hang on a caller-held gate, and the gateway's streamLLM is
// mocked in-process — the SAME gate holds the fill's stream, so the window
// under test is exactly the one the browser bug lived in (cards blank
// between `result` and the traversal's resolve).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	investigation,
	resetInvestigation,
} from '../src/lib/investigation.svelte';
import { resetShell } from '../src/lib/shell.svelte';
import { settings } from '../src/lib/settings.svelte';
import { _closeForTests, clearAllLocalData, initPersistence } from '$lib/db';
import {
	createTransport,
	type CountResult,
	type FetchResult,
	type FetchRoute,
	type FetchSlice,
	type RelayCapability,
	type RelayStatus,
	type Transport,
} from '$lib/net/transport';
import type { CallLLM } from '$lib/ai/output';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';

vi.mock('$lib/net/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/net/transport')>();
	return { ...actual, createTransport: vi.fn() };
});

/** The gate every traversal leg hangs on. The fill's mocked stream holds on
 * the SAME promise (a real fill runs seconds, the traversal too) — tests
 * flip it to land the settle. */
let openSettle: () => void = () => {};
let settleGate: Promise<void> = Promise.resolve();

/** KV text for the ids a fill pass asked about (same record shape as
 * fillLanes.test.ts). */
function askedIds(content: unknown): string[] {
	const parsed = JSON.parse(String(content)) as { id: string }[];
	return parsed.map((a) => a.id);
}

/** The mocked gateway stream: the FIRST record completes before the hold
 * (so one card paints mid-window — the merge must keep that paint), the
 * rest arrive after the gate opens. */
const streamTap = vi.fn(async function* (args: {
	messages: { content: unknown }[];
}): AsyncIterable<string> {
	const ids = askedIds(args.messages[0].content);
	const kv = (id: string) => `id: ${id}\ntitle: T-${id}\nsnippet: S-${id}`;
	yield `${kv(ids[0])}\n\n`;
	await settleGate;
	for (const id of ids.slice(1)) yield `${kv(id)}\n\n`;
});

vi.mock('$lib/ai/gateway', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/ai/gateway')>();
	return {
		...actual,
		streamLLM: (args: { messages: { content: unknown }[] }) => streamTap(args),
	};
});

/** Genuinely-signed product (admission gates require real sig + NIP-01 id;
 * same pattern as settle.test.ts). */
function forgeProduct(seed: string): NostrEvent {
	return finalizeEvent(
		{
			kind: 1,
			created_at: 1_780_000_000,
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-v0.8.1'],
				['t', 'scrutiny-product'],
				['i', `cve:CVE-${seed}-1`]
			],
			content: `content of ${seed}`
		},
		generateSecretKey()
	);
}

/** Transport whose TRAVERSAL legs hang on the settle gate; the search legs
 * answer with `searchEvents` immediately (the products arrive
 * pre-context, exactly the browser run's shape). Traversal legs deliver
 * `contextEvents` once opened (the settle-arrival shape of the third test). */
class GatedTransport implements Transport {
	constructor(
		private readonly searchEvents: NostrEvent[],
		private readonly contextEvents: NostrEvent[] = []
	) {}
	urls: string[] = ['ws://relay.test'];
	async fetchRouted(
		routes: FetchRoute[],
		onSlice: (s: FetchSlice) => void
	): Promise<FetchResult> {
		const traversal = routes.some((r) => r.label.startsWith('traversal'));
		if (traversal) await settleGate;
		const answer = traversal ? this.contextEvents : this.searchEvents;
		const events: NostrEvent[] = [];
		const seen = new Set<string>();
		for (const route of routes) {
			const status: RelayStatus = {
				url: route.urls[0] ?? 'ws://relay.test',
				status: 'ok',
				count: answer.length
			};
			onSlice({ url: status.url, events: answer, status, route: route.label });
			for (const e of answer) {
				if (seen.has(e.id)) continue;
				seen.add(e.id);
				events.push(e);
			}
		}
		return { events, relays: [] };
	}
	fetch(_filters: unknown[]): Promise<FetchResult> {
		return Promise.reject(new Error('unused'));
	}
	fetchProgressive(filters: Filter[], onSlice: (s: FetchSlice) => void): Promise<FetchResult> {
		return this.fetchRouted([{ label: 'default', urls: this.urls, filters }], onSlice);
	}
	count(_filters: unknown[]): Promise<CountResult> {
		return Promise.reject(new Error('unused'));
	}
	capability(_url: string): Promise<RelayCapability> {
		return Promise.resolve('unknown');
	}
	capabilitySync(_url: string): RelayCapability {
		return 'unknown';
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

/** Identifier-only question: routes straight to a tag search (no AI
 * translate call), so the card fill is the only LLM lane. */
const QUESTION = 'cve:CVE-2017-15361';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetInvestigation();
	resetShell();
	settleGate = new Promise<void>((resolve) => {
		openSettle = resolve;
	});
	streamTap.mockClear();
	settings.apiKey = 'sk-test-early';
	settings.model = 'm-early';
});

afterEach(async () => {
	resetInvestigation();
	resetShell();
	await _closeForTests();
});

describe('start() — early fill fires while the settle traversal still runs (issue #118)', () => {
	it('a fill chunk is PENDING during the traversal hold — cards interpret before context lands', async () => {
		const products = ['a1', 'b2', 'c3'].map(forgeProduct);
		vi.mocked(createTransport).mockReturnValue(new GatedTransport(products));

		const started = investigation.start(QUESTION);

		// The early-leg window: search legs answered, traversal still hung.
		// The pre-context cohort mounted AND its fill chunk claimed — the
		// ids read `interpreting…` (pending) BEFORE the settle gate opens —
		// and the fill's stream call is already on the wire, not just armed
		// (fillCards passes through the (eventId, model) IDB cache before
		// the stream fires, so the tap lags the claim by a tick).
		await vi.waitFor(() => {
			expect(investigation.cards.length).toBe(3);
			expect(investigation.pending.size).toBe(3);
			expect(streamTap).toHaveBeenCalled();
		});

		openSettle();
		await started;

		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);
		expect(investigation.pending.size).toBe(0);
		// The banner counter survives the top-up leg's entry reset (review
		// P2 on the first #118 pass): a second fillInChunks entry must not
		// zero fillStats below cards that already interpreted — the trace
		// row and the aria-live fill verdict both read it (spec §2 rule 6).
		expect(investigation.fillStats.interpreted).toBe(3);
		expect(investigation.fillStats.total).toBe(3);
	});

	it('the merge keeps slot order and mid-flight paint — a card interpreted before the gate stays interpreted after', async () => {
		const products = ['a1', 'b2', 'c3'].map(forgeProduct);
		vi.mocked(createTransport).mockReturnValue(new GatedTransport(products));

		const started = investigation.start(QUESTION);

		// The mocked stream completes the FIRST record before its hold, so
		// card a1 paints while the traversal still runs.
		await vi.waitFor(() => {
			expect(investigation.cards[0]?.interpreted).toBe(true);
			expect(investigation.cards.length).toBe(3);
		});

		openSettle();
		await started;

		// Slot order preserved (the pre-context ids, in assembly order) and
		// the pre-gate paint survived the merge — never reverted to raw.
		expect(investigation.cards.map((c) => c.id)).toEqual(products.map((p) => p.id));
		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);
	});

	it('a context arrival appends to the merged cohort — the top-up covers it once armed', async () => {
		const preContext = ['a1', 'b2', 'c3'].map(forgeProduct);
		const arrival = forgeProduct('d4');
		// The traversal legs deliver the 4th product once the gate opens —
		// admitContext pushes it into the session, the merge appends its
		// card past the live cohort.
		vi.mocked(createTransport).mockReturnValue(
			new GatedTransport(preContext, [arrival])
		);

		const started = investigation.start(QUESTION);

		await vi.waitFor(() => expect(investigation.cards.length).toBe(3));
		// The #106 contract: arming is the surface's job. Arm the arrival's
		// id BEFORE the settle — armed ids are sticky strings, so the
		// top-up leg's claim gate sees it the moment the merge appends the
		// card (a post-merge arm would race the top-up's already-exited
		// scan and leave the arrival fill to an unawaited armChunk cycle).
		investigation.armChunk(arrival.id);
		openSettle();
		// The merge lands the arrival while the early leg drains.
		await vi.waitFor(() => expect(investigation.cards.length).toBe(4));
		await started;
		// The arrival can fill in the top-up leg or in the armChunk cycle
		// — either way it settles shortly after the run does.
		await vi.waitFor(() =>
			expect(investigation.cards.every((c) => c.interpreted)).toBe(true)
		);

		expect(investigation.cards.map((c) => c.id)).toContain(arrival.id);
		// The early leg's chunk plus the arrival's chunk — two streamed
		// fill passes at minimum.
		expect(streamTap.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
