// Pipeline orchestrator (issue #28, spec §2/§3/§11 step 2): translate →
// capability-aware fan-out (NIP-50 vs fullScanFilter vs tag) → admit+cache
// in completion order → skeleton sources → session. Progress state and all
// notices are deterministic; the UI is only a reader.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';
import type { CallLLM } from '$lib/ai/output';
import type { Transport, RelayCapability, FetchSlice } from '$lib/net/transport';
import { _closeForTests, clearAllLocalData, initPersistence } from '$lib/db';
import { resetSearchEngine, searchText } from '$lib/search';
import { runSearch, type PipelineEvent } from '../src/lib/pipeline';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

/** Fake that records filters and delivers scripted slices in config order. */
class FakeTransport implements Transport {
	readonly captured: Filter[][] = [];
	constructor(
		private readonly scripts: Record<string, { events: NostrEvent[]; count?: number }>,
		private readonly caps: Record<string, RelayCapability> = {}
	) {}

	async fetch(): Promise<never> {
		throw new Error('unused by pipeline');
	}

	async count(filters: Filter[]) {
		const merged = Object.fromEntries(
			Object.entries(this.scripts).map(([u, s]) => [u, s.count ?? s.events.length])
		);
		return {
			total: Object.values(merged).reduce((a, b) => a + b, 0),
			relays: Object.entries(merged).map(([url, count]) => ({ url, status: 'ok' as const, count }))
		};
	}

	async capability(url: string): Promise<RelayCapability> {
		return this.caps[url] ?? 'unknown';
	}

	capabilitySync(url: string): RelayCapability {
		return this.caps[url] ?? 'unknown';
	}

	async fetchProgressive(filters: Filter[], onSlice: (slice: FetchSlice) => void) {
		this.captured.push(filters);
		return this.fetchRouted([{ label: 'default', urls: Object.keys(this.scripts), filters }], onSlice);
	}

	async fetchRouted(routes: import('$lib/net/transport').FetchRoute[], onSlice: (slice: FetchSlice) => void) {
		for (const route of routes) this.captured.push(route.filters);
		const events: NostrEvent[] = [];
		const seen = new Set<string>();
		for (const route of routes) {
			for (const url of route.urls) {
				const script = this.scripts[url];
				if (!script) continue;
				onSlice({
					url,
					events: script.events,
					status: { url, status: 'ok' as const, count: script.events.length },
					route: route.label
				});
				for (const e of script.events) {
					if (!seen.has(e.id)) {
						seen.add(e.id);
						events.push(e);
					}
				}
			}
		}
		return { events, relays: [] };
	}

	async close() {}
}

function event(id: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
	return {
		id: id.padEnd(64, '0').slice(0, 64).replaceAll(/[^0-9a-f]/g, '0'),
		sig: 'cd'.repeat(64),
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [
			['t', 'scrutiny-fabric'],
			['i', 'cve:CVE-2017-15361']
		],
		content: `content of ${id}`,
		...overrides
	};
}

function llmPlan(plan: string): CallLLM {
	return async () => plan;
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

afterEach(() => {
	resetSearchEngine();
	_closeForTests();
});

describe('runSearch — capability-aware routing (spec §3)', () => {
	it('text searches use NIP-50 on capable relays and fullScanFilter on relay-declared-lacks', async () => {
		const transport = new FakeTransport(
			{ 'wss://capable': { events: [event('a1')] }, 'wss://sparse': { events: [event('a2')] } },
			{ 'wss://capable': 'supports', 'wss://sparse': 'lacks' }
		);
		const session = await runSearch({
			question: 'ROCA vulnerability in Infineon chips',
			relays: ['wss://capable', 'wss://sparse'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"ROCA Infineon"}]'),
			transport,
			admit: () => ({ ok: true })
		});

		// The fallback row uses NO search term (fullScanFilter = tag scan), the
		// capable one carries the search string.
		const fallbackFilters = transport.captured.flat().filter((f) => f.search === undefined);
		expect(fallbackFilters.length).toBeGreaterThan(0);
		const nip50Filters = transport.captured.flat().filter((f) => typeof f.search === 'string');
		expect(nip50Filters.length).toBe(1);

		expect(session.notices.some((n) => n.kind === 'capability' && n.message.includes('wss://sparse'))).toBe(true);
		expect(session.admitted.map((e) => e.id)).toEqual([event('a1').id, event('a2').id]);
	});

	it('tag searches route as i-tag filters on every relay regardless of capability', async () => {
		const transport = new FakeTransport(
			{ 'wss://capable': { events: [] }, 'wss://sparse': { events: [] } },
			{ 'wss://capable': 'supports', 'wss://sparse': 'lacks' }
		);
		await runSearch({
			question: 'CVE-2017-15361',
			relays: ['wss://capable', 'wss://sparse'],
			provider: PROVIDER,
			callLLM: llmPlan('[]'),
			transport,
			admit: () => ({ ok: true })
		});
		const all = transport.captured.flat();
		expect(all.every((f) => Array.isArray(f['#i']))).toBe(true);
	});

	it('unknown capability falls back to attempting NIP-50 (strfry-style absent probe)', async () => {
		const transport = new FakeTransport({ 'wss://few': { events: [event('a3')] } }, {});
		await runSearch({
			question: 'ROCA chips',
			relays: ['wss://few'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"ROCA"}]'),
			transport,
			admit: () => ({ ok: true })
		});
		expect(transport.captured.flat().some((f) => typeof f.search === 'string')).toBe(true);
	});
});

describe('runSearch — admit, cache, and skipped counts (spec §4)', () => {
	it('dedupes overlapping events across relays and counts admitted once', async () => {
		const shared = event('99'.repeat(32));
		const transport = new FakeTransport({
			'wss://a': { events: [shared, event('11'.repeat(32))] },
			'wss://b': { events: [shared] }
		});
		const session = await runSearch({
			question: 'anything',
			relays: ['wss://a', 'wss://b'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true })
		});
		expect(session.admitted.map((e) => e.id)).toEqual([shared.id, event('11'.repeat(32)).id]);
	});

	it('silently skips events that fail admission and reports the footer count', async () => {
		const transport = new FakeTransport({
			'wss://a': { events: [event('good1'), event('bad1'), event('bad2')] }
		});
		const session = await runSearch({
			question: 'anything',
			relays: ['wss://a'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: (e) => ({ ok: e.id === event('good1').id })
		});
		expect(session.admitted).toHaveLength(1);
		expect(session.invalidSkipped).toBe(2);
		expect(session.notices.some((n) => n.kind === 'invalid-skipped' && n.message.includes('2'))).toBe(true);
	});

	it('admitted events land in the local cache + index (search seam)', async () => {
		const transport = new FakeTransport({ 'wss://a': { events: [event('cache1', { content: 'indexed here' })] } });
		await runSearch({
			question: 'anything',
			relays: ['wss://a'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true })
		});
		expect(await searchText('indexed')).toEqual([event('cache1').id]);
	});
});

describe('runSearch — progressive emission (spec §7: skeletons instantly)', () => {
	it('emits skeleton cards before ALL relays settle (first-slice-first, not EOSE-at-the-end)', async () => {
		const sequence: string[] = [];
		const transport = new FakeTransport({ 'wss://a': { events: [event('s1')] }, 'wss://b': { events: [event('s2')] } });
		await runSearch({
			question: 'anything',
			relays: ['wss://a', 'wss://b'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true }),
			emit: (e: PipelineEvent) => {
				if (e.type === 'skeleton') sequence.push(...e.cards.map((c) => c.id));
				if (e.type === 'phase') sequence.push(`phase:${e.phase}`);
			}
		});
		// Skeletons MUST arrive before the 'done' phase — paint-at-first-slice.
		const skeletonIdx = sequence.indexOf(event('s1').id);
		const doneIdx = sequence.indexOf('phase:done');
		expect(skeletonIdx).toBeGreaterThanOrEqual(0);
		expect(doneIdx).toBeGreaterThan(skeletonIdx);
	});

	it('marks every skeleton as not-interpreted (spec §2 rule 5)', async () => {
		const sequence: PipelineEvent[] = [];
		const transport = new FakeTransport({ 'wss://a': { events: [event('n1')] } });
		await runSearch({
			question: 'anything',
			relays: ['wss://a'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true }),
			emit: (e) => sequence.push(e)
		});
		const skeletons = sequence.filter((e): e is { type: 'skeleton'; cards: Array<{ id: string; interpreted: boolean }> } => e.type === 'skeleton');
		expect(skeletons.length).toBeGreaterThan(0);
		expect(skeletons.every((s) => s.cards.every((c) => c.interpreted === false))).toBe(true);
	});
});

describe('runSearch — truncation honesty (spec §3: "fetched N, relays may hold more")', () => {
	it('emits a truncation notice when COUNT exceeds the fetched count', async () => {
		const transport = new FakeTransport({ 'wss://a': { events: [event('t1')], count: 42 } });
		const session = await runSearch({
			question: 'anything',
			relays: ['wss://a'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true })
		});
		expect(session.notices.some((n) => n.kind === 'truncated' && n.message.includes('1'))).toBe(true);
	});

	it('no notice when COUNT matches the fetched count', async () => {
		const transport = new FakeTransport({ 'wss://a': { events: [event('t1'), event('t2')] } });
		const session = await runSearch({
			question: 'anything',
			relays: ['wss://a'],
			provider: PROVIDER,
			callLLM: llmPlan('[{"kind":"text","value":"anything"}]'),
			transport,
			admit: () => ({ ok: true })
		});
		expect(session.notices.some((n) => n.kind === 'truncated')).toBe(false);
	});
});
