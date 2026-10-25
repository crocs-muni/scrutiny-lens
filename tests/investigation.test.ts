// Results-surface fill banner (spec §2 never-lie, §6 deterministic wording):
// the zero-fill text must reflect WHY the fill failed. A dead endpoint
// (unreachable/timeout) says "Endpoint unreachable", but an endpoint that
// answered and produced non-conforming output (schema_failure) — or answered
// 429, throttling us (rate_limited) — must NOT be labeled unreachable: that
// is the owner's incident. User-visible text speaks issue #108's raw/filled
// vocabulary — never "AI" or "interpreted".
//
// It also guards issue #131 at the store level: the run's relay pool is
// frozen at start() and every later leg reads that snapshot, so a Settings
// edit can never make one run query two pools.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
	_closeForTests,
	clearAllLocalData,
	getSessionRun,
	initPersistence,
	putSessionRun,
	saveSettings,
} from '$lib/db';
import { indexEvent } from '$lib/search';
import {
	createTransport,
	type CountResult,
	type FetchResult,
	type FetchRoute,
	type FetchSlice,
	type RelayCapability,
	type Transport,
} from '$lib/net/transport';
import {
	fillNote,
	investigation,
	recordFillFailure,
	resetInvestigation,
} from '../src/lib/investigation.svelte';
import { aggregatePerRelay } from '../src/lib/relay-readout';
import { resetShell, shell } from '../src/lib/shell.svelte';
import { resetSettings, settings } from '../src/lib/settings.svelte';
import type { SearchSession } from '../src/lib/pipeline';
import type { AIKind } from '../src/lib/ai/output';

// The run tests below inject a transport; everything else in this file never
// touches the network layer.
vi.mock('$lib/net/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/net/transport')>();
	return { ...actual, createTransport: vi.fn() };
});

describe('fillNote — says the truth about why cards stayed raw', () => {
	it('endpoint answered but every fill failed schema → not "unreachable"', () => {
		const note = fillNote(0, 5, 'schema_failure');
		expect(note).toBe("Output didn't conform — cards show the raw events");
		expect(note).not.toContain('unreachable');
	});

	it('endpoint unreachable → still "Endpoint unreachable"', () => {
		expect(fillNote(0, 5, 'unreachable')).toBe('Endpoint unreachable — cards show the raw events');
		expect(fillNote(0, 5, 'timeout')).toBe('Endpoint unreachable — cards show the raw events');
	});

	it('browser blocked the request (CORS/mixed content) → names the browser, not "unreachable"', () => {
		const note = fillNote(0, 5, 'browser_blocked');
		expect(note).toBe(
			'Endpoint blocked by the browser (CORS or mixed content) — cards show the raw events'
		);
		expect(note).not.toContain('unreachable');
	});

	it('endpoint answered 429 (throttled) → names rate limiting, not "unreachable"', () => {
		const note = fillNote(0, 5, 'rate_limited');
		expect(note).toBe('Endpoint rate limited — cards show the raw events');
		expect(note).not.toContain('unreachable');
	});

	it('appends the endpoint-stated 429 count when the run saw any (#105)', () => {
		// The count is what the gateway actually SAW this run (spec §2),
		// carried as a trailing suffix so a wording pass (#108, landed) can
		// rewrite the head sentence without touching the count.
		expect(fillNote(0, 5, 'rate_limited', null, 2)).toBe(
			'Endpoint rate limited — cards show the raw events · endpoint rate limited 2×'
		);
		// Zero means the retries cleared everything — the bare sentence
		// already says what happened, no suffix.
		expect(fillNote(0, 5, 'rate_limited', null, 0)).toBe(
			'Endpoint rate limited — cards show the raw events'
		);
		expect(fillNote(0, 5, 'rate_limited')).toBe(
			'Endpoint rate limited — cards show the raw events'
		);
	});

	it('partial fill stays numeric and never "broken"', () => {
		expect(fillNote(2, 5, 'schema_failure')).toBe(
			'Slow — 2 of 5 cards filled · the rest show the raw events'
		);
	});

	it('full fill or no cards → no banner', () => {
		expect(fillNote(5, 5, 'schema_failure')).toBe('');
		expect(fillNote(0, 0, 'schema_failure')).toBe('');
	});

	it('names the concrete reason next to the class (PR #50 lane)', () => {
		expect(fillNote(0, 5, 'unreachable', 'fetch failed with status 503')).toBe(
			'Endpoint unreachable (fetch failed with status 503) — cards show the raw events'
		);
		expect(fillNote(0, 5, 'schema_failure', 'zod: id missing on card 3')).toBe(
			"Output didn't conform (zod: id missing on card 3) — cards show the raw events"
		);
		// Empty/absent reasons keep the bare sentence (no dangling parens).
		expect(fillNote(0, 5, 'unreachable', '')).toBe('Endpoint unreachable — cards show the raw events');
	});
});

describe('recordFillFailure — kind and message stay paired under stickiness', () => {
	const state = (): { fillFailure: AIKind | null; fillErrorMessage: string | null } => ({
		fillFailure: null,
		fillErrorMessage: null
	});

	it('schema_failure + its reason win over a later chunk failure', () => {
		const s = state();
		recordFillFailure(s, 'schema_failure', 'zod: id missing on card 3');
		recordFillFailure(s, 'unreachable', 'fetch failed with status 503');
		expect(s.fillFailure).toBe('schema_failure');
		expect(s.fillErrorMessage).toBe('zod: id missing on card 3');
	});

	it('rate_limited is equally sticky (a 429 proves reachability)', () => {
		const s = state();
		recordFillFailure(s, 'rate_limited', 'Retry-After: 15');
		recordFillFailure(s, 'unreachable', 'ECONNRESET');
		expect(s.fillFailure).toBe('rate_limited');
		expect(s.fillErrorMessage).toBe('Retry-After: 15');
	});

	it('first-wins for non-sticky kinds; only the winner pairs the reason', () => {
		const s = state();
		recordFillFailure(s, 'unreachable', 'fetch failed with status 503');
		recordFillFailure(s, 'timeout', 'PER_CHUNK budget exceeded');
		expect(s.fillFailure).toBe('timeout');
		expect(s.fillErrorMessage).toBe('PER_CHUNK budget exceeded');
	});

	it('the reason clips at 140 chars and never carries a key (ADR-018)', () => {
		const s = state();
		recordFillFailure(s, 'unreachable', 'x'.repeat(200) + ' sk-secret-123');
		expect(s.fillErrorMessage).toHaveLength(140);
		expect(s.fillErrorMessage?.endsWith('…')).toBe(true);
		expect(s.fillErrorMessage).not.toContain('sk-secret-123');
	});
});

// issue #85 (spec §9 glossary): selecting another PRODUCT while on the
// session surface re-anchors the subject graph on it; a metadata selection
// moves only the ring + dossier. The classification is core's own
// scrutinyEventType — the same t-tag predicate deriveSubjectGraph gates on —
// so these events carry only the t tags the classifier reads.
describe('selectSubject — product re-anchor (issue #85, spec §9)', () => {
	const event = (id: string, type: 'scrutiny-product' | 'scrutiny-metadata') => ({
		id,
		kind: 1,
		created_at: 1_780_000_000,
		content: '',
		sig: '',
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', type],
		],
	});
	const session = (admitted: unknown[]): SearchSession =>
		({
			searches: [],
			admitted,
			invalidSkipped: 0,
			notices: [],
		}) as unknown as SearchSession;

	beforeEach(() => resetInvestigation());
	afterEach(() => resetInvestigation());

	it('first product selection anchors the graph', () => {
		investigation.result = session([event('p1', 'scrutiny-product')]);
		investigation.selectSubject('p1');
		expect(investigation.graphSubjectId).toBe('p1');
		expect(investigation.selectedEventId).toBe('p1');
	});

	it('a second product selection re-anchors on it', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('p2', 'scrutiny-product'),
		]);
		investigation.selectSubject('p1');
		investigation.selectSubject('p2');
		expect(investigation.graphSubjectId).toBe('p2');
		expect(investigation.selectedEventId).toBe('p2');
	});

	it('a metadata selection never moves the anchor (ring + dossier only)', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('m1', 'scrutiny-metadata'),
		]);
		investigation.selectSubject('p1');
		investigation.selectSubject('m1');
		// The dossier follows the click; the graph stays anchored on p1.
		expect(investigation.selectedEventId).toBe('m1');
		expect(investigation.graphSubjectId).toBe('p1');
	});

	it('a metadata-first session still gets a subject graph (#29b ruling 4)', () => {
		investigation.result = session([event('m1', 'scrutiny-metadata')]);
		investigation.selectSubject('m1');
		expect(investigation.graphSubjectId).toBe('m1');
	});

	it('an event outside the admitted set keeps the old first-subject rule (never anchors on a guess)', () => {
		investigation.result = session([event('p1', 'scrutiny-product')]);
		// Unknown kind: the anchor is only filled when still empty.
		investigation.selectSubject('ghost');
		expect(investigation.graphSubjectId).toBe('ghost');
		investigation.selectSubject('lone-product');
		expect(investigation.graphSubjectId).toBe('ghost');
	});

	it('expansion state clears on re-anchor and survives a same-anchor repeat', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('p2', 'scrutiny-product'),
		]);
		investigation.selectSubject('p1');
		investigation.expandRelated('r1');
		investigation.expandBridge('b1');
		expect(investigation.expandedRelated).toEqual(['r1']);
		expect(investigation.expandedBridges).toEqual(['b1']);
		expect(investigation.expansionLog).toEqual(['related', 'bridge']);

		// Re-clicking the SAME anchor is not a swap — the neighborhood survives.
		investigation.selectSubject('p1');
		expect(investigation.expandedRelated).toEqual(['r1']);
		expect(investigation.expandedBridges).toEqual(['b1']);
		expect(investigation.expansionLog).toEqual(['related', 'bridge']);

		// A real swap drops the old anchor's neighborhood (#29b ruling 8, #97).
		investigation.selectSubject('p2');
		expect(investigation.graphSubjectId).toBe('p2');
		expect(investigation.expandedRelated).toEqual([]);
		expect(investigation.expandedBridges).toEqual([]);
		expect(investigation.expansionLog).toEqual([]);
	});
});

// issue #132's root: the trace's literal layer is one slice per LEG, so a
// relay legitimately appears several times with different verdicts. The
// readout must fold those to ONE receipt per relay — anything else shows the
// same relay twice with contradictory statuses.
describe('aggregatePerRelay — one receipt per relay (issue #132)', () => {
	it('an answering leg wins over a failing one; received/rejected sum; legs count', () => {
		const receipts = aggregatePerRelay([
			{ url: 'wss://a.test', received: 4, rejected: 1, route: 'tag:cve', status: 'ok' },
			{ url: 'wss://b.test', received: 0, rejected: 0, route: 'tag:cve', status: 'timeout' },
			{ url: 'wss://a.test', received: 0, rejected: 0, route: 'text:roca', status: 'refused' },
		]);

		expect(receipts).toEqual([
			{ url: 'wss://a.test', status: 'ok', routes: 2, received: 4, rejected: 1 },
			{ url: 'wss://b.test', status: 'timeout', routes: 1, received: 0, rejected: 0 },
		]);
		// First appearance wins position — the last a.test slice never moves it.
		expect(receipts.map((r) => r.url)).toEqual(['wss://a.test', 'wss://b.test']);
	});

	it('without any answering leg, a refusal outranks a timeout', () => {
		const [receipt] = aggregatePerRelay([
			{ url: 'wss://a.test', received: 0, rejected: 0, route: 'tag:cve', status: 'timeout' },
			{ url: 'wss://a.test', received: 0, rejected: 0, route: 'text:roca', status: 'refused' },
		]);
		expect(receipt.status).toBe('refused');
		expect(receipt.routes).toBe(2);
	});

	it('the local cache is not a relay (spec §2: name the relays actually asked)', () => {
		const receipts = aggregatePerRelay([
			{ url: 'local-cache', received: 9, rejected: 0, route: 'cache', status: 'ok' },
			{ url: 'wss://a.test', received: 2, rejected: 0, route: 'tag:cve', status: 'ok' },
		]);
		expect(receipts.map((r) => r.url)).toEqual(['wss://a.test']);
	});

	it('one relay re-asked on the SAME route is one leg, not two', () => {
		const [receipt] = aggregatePerRelay([
			{ url: 'wss://a.test', received: 1, rejected: 0, route: 'traversal:bindings', status: 'ok' },
			{ url: 'wss://a.test', received: 2, rejected: 0, route: 'traversal:bindings', status: 'ok' },
		]);
		expect(receipt.routes).toBe(1);
		expect(receipt.received).toBe(3);
	});
});

// issue #131: the run queries ONE pool. The snapshot is taken at start(); the
// settle traversal and the dossier legs read it, never live Settings — so a
// Settings edit re-points the next run only (spec §2: the trace names the
// relays that were actually asked).
describe('runRelays — the run owns its relay pool (issue #131)', () => {
	const POOL = ['wss://a.test', 'wss://b.test'];

	/** Genuinely-signed synthetic product (real key, real NIP-01 id — the
	 * admission gates require both; same shape as settle.test.ts). */
	function cve(): NostrEvent {
		return finalizeEvent(
			{
				kind: 1,
				created_at: 1_780_000_000,
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-v0.8.1'],
					['t', 'scrutiny-product'],
					['i', 'cve:CVE-2017-15361'],
				],
				content: 'ROCA fingerprint',
			},
			generateSecretKey(),
		);
	}

	/** Answers every route with the same events: these tests assert WHICH POOL
	 * the run asked, not per-route routing (pipeline.test.ts owns that). */
	class ProbeTransport implements Transport {
		readonly legs: string[][] = [];
		constructor(private readonly answer: NostrEvent[]) {}
		async fetchRouted(
			routes: FetchRoute[],
			onSlice: (slice: FetchSlice) => void,
		): Promise<FetchResult> {
			this.legs.push(routes.map((route) => route.label));
			for (const route of routes) {
				for (const url of route.urls) {
					onSlice({
						url,
						events: this.answer,
						status: { url, status: 'ok', count: this.answer.length },
						route: route.label,
					});
				}
			}
			return { events: [...this.answer], relays: [] };
		}
		fetch(): Promise<FetchResult> {
			return Promise.reject(new Error('unused'));
		}
		fetchProgressive(): Promise<FetchResult> {
			return Promise.reject(new Error('unused'));
		}
		/** "No relay could state a COUNT" — truncationNotices stays silent. */
		count(): Promise<CountResult> {
			return Promise.resolve({ total: 0, relays: [] });
		}
		capability(): Promise<RelayCapability> {
			return Promise.resolve('unknown');
		}
		capabilitySync(): RelayCapability {
			return 'unknown';
		}
		close(): Promise<void> {
			return Promise.resolve();
		}
	}

	/** Every pool the run handed to createTransport, in call order. */
	function recordPools(transport: Transport, onFirstCall?: () => void): string[][] {
		const asked: string[][] = [];
		vi.mocked(createTransport).mockImplementation(((opts: { urls: string[] }) => {
			asked.push([...opts.urls]);
			if (asked.length === 1) onFirstCall?.();
			return transport;
		}) as unknown as typeof createTransport);
		return asked;
	}

	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
		resetInvestigation();
		resetShell();
		resetSettings();
		// No provider and no model: translate degrades to a plain-text search
		// and no fill lane fires — these runs never reach an endpoint.
		settings.apiKey = '';
		settings.model = '';
		settings.relays = [...POOL];
	});

	afterEach(async () => {
		resetInvestigation();
		resetShell();
		resetSettings();
		vi.clearAllMocks();
		await _closeForTests();
	});

	it('a mid-run Settings edit never re-points the live run', async () => {
		const transport = new ProbeTransport([cve()]);
		// The edit lands with the search leg's transport already live: the
		// settle traversal has NOT created its own yet.
		const asked = recordPools(transport, () => {
			settings.relays = ['wss://other.test'];
		});

		await investigation.start('roca nomad bug');

		expect(settings.relays).toEqual(['wss://other.test']); // the edit did land
		expect(transport.legs.length).toBeGreaterThanOrEqual(2); // search + settle traversal
		expect(asked.length).toBeGreaterThanOrEqual(2);
		expect(asked.every((urls) => urls.join(' ') === POOL.join(' '))).toBe(true);
		expect(investigation.runRelays).toEqual(POOL);
	});

	it('pins the pool and one folded receipt per relay into the run row', async () => {
		const transport = new ProbeTransport([cve()]);
		recordPools(transport);

		await investigation.start('roca nomad bug');

		const id = shell.session?.id ?? '';
		expect(id).not.toBe('');
		// persistRunRecord is fire-and-forget like the orchestrator's other
		// write-through — poll the read-back instead of racing the commit.
		await vi.waitFor(async () => {
			const row = await getSessionRun(id);
			expect(row?.relays?.pool).toEqual(POOL);
			// Several legs, two relays → two receipts, never one row per leg.
			expect(row?.relays?.perRelay.map((r) => r.url)).toEqual(POOL);
			expect(row?.relays?.perRelay.every((r) => r.status === 'ok')).toBe(true);
		});
	});

	it('waits for the boot barrier: a pre-hydration submit asks the PERSISTED pool', async () => {
		await saveSettings({ relays: ['wss://persisted.test'] });
		resetSettings(); // a fresh boot: nothing hydrated, defaults in the state
		settings.apiKey = '';
		settings.model = '';
		const transport = new ProbeTransport([cve()]);
		const asked = recordPools(transport);

		await investigation.start('roca nomad bug');

		expect(asked[0]).toEqual(['wss://persisted.test']); // not the defaults
		expect(investigation.runRelays).toEqual(['wss://persisted.test']);
	});

	it('a legacy row (no recorded pool) fetches dossier context from today’s pool instead of throwing', async () => {
		const root = cve();
		await indexEvent(root);
		const legacy = 'legacy-session';
		shell.sessions = [{ id: legacy, title: 'Legacy', createdAt: 1 }];
		await putSessionRun({
			sessionId: legacy,
			searches: [],
			admittedIds: [root.id],
			settledAt: 1,
			elapsedMs: 0,
		});
		const transport = new ProbeTransport([]);
		const asked = recordPools(transport);

		expect(await investigation.restore(legacy)).toBe(true);
		// "Not recorded", never "ask nothing": the snapshot stays empty…
		expect(investigation.runRelays).toEqual([]);
		await investigation.refreshSessionContext();

		// …but the leg falls back to live settings, so no createTransport
		// throw ('transport needs at least one relay url') lands as a §4
		// traversal notice instead of a fetched dossier context.
		expect(asked[0]).toEqual(POOL);
		expect(investigation.notices).toEqual([]);
	});

	it('re-pins a restored run’s recorded receipts when ANOTHER restore displaces it', async () => {
		const a = cve();
		const b = cve();
		await indexEvent(a);
		await indexEvent(b);
		shell.sessions = [
			{ id: 'run-a', title: 'A', createdAt: 2 },
			{ id: 'run-b', title: 'B', createdAt: 1 },
		];
		const receipts = [
			{ url: 'wss://a.test', status: 'ok', count: 12 },
			{ url: 'wss://b.test', status: 'refused', count: 0 },
		];
		await putSessionRun({
			sessionId: 'run-a',
			searches: [],
			admittedIds: [a.id],
			settledAt: 1,
			elapsedMs: 10,
			relays: { pool: POOL, perRelay: receipts },
		});
		await putSessionRun({
			sessionId: 'run-b',
			searches: [],
			admittedIds: [b.id],
			settledAt: 2,
			elapsedMs: 20,
			relays: { pool: ['wss://b.test'], perRelay: [{ url: 'wss://b.test', status: 'ok', count: 1 }] },
		});
		recordPools(new ProbeTransport([]));

		expect(await investigation.restore('run-a')).toBe(true);
		// Displacement re-pins run-a from a cache-only slice list: the fold is
		// empty, so the receipts must come from its own record, not vanish.
		expect(await investigation.restore('run-b')).toBe(true);

		await vi.waitFor(async () => {
			const row = await getSessionRun('run-a');
			expect(row?.relays?.pool).toEqual(POOL);
			expect(row?.relays?.perRelay).toEqual(receipts);
		});
		// The displacing run pins its OWN receipts, never run-a's.
		const rowB = await getSessionRun('run-b');
		expect(rowB?.relays?.perRelay).toEqual([{ url: 'wss://b.test', status: 'ok', count: 1 }]);
	});

	it('a cold open pins the resolver’s receipts into the run row (finding 8)', async () => {
		recordPools(new ProbeTransport([]));
		const root = cve();

		await investigation.openShared(root, [], false, [{ url: 'wss://hint.test', status: 'ok' }]);

		// The cold open slices no relay leg, so its receipts live in the
		// run-scoped carrier — the trace/readout's source for a shared run.
		expect(investigation.recordedRelayReceipts).toEqual([
			{ url: 'wss://hint.test', status: 'ok', routes: 1, received: 0, rejected: 0 },
		]);
		const id = investigation.sessionId ?? '';
		expect(id).not.toBe('');
		await vi.waitFor(async () => {
			const row = await getSessionRun(id);
			// The dossier legs asked the configured pool; the row's receipts
			// are the resolver's, not an empty fold claiming nobody was asked.
			expect(row?.relays?.pool).toEqual(POOL);
			expect(row?.relays?.perRelay).toEqual([
				{ url: 'wss://hint.test', status: 'ok', count: 0 },
			]);
		});
	});
});
