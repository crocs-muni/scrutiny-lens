// Settle merge must never carry STALE deterministic facts (spec §2 rule 2:
// counts are computed, never written by AI, and never allowed to disagree
// with the session header). Repro found with the screenshot harness: with a
// fill lane running during the §8.2 traversal, cards kept their PRE-context
// assembly and rendered "0 metadata" while the session header said "3
// metadata". These tests drive the REAL start(), with the same transport /
// gateway gates as settle-early-fill.test.ts.
//
// Expected to be RED until the merge keeps fresh deterministic fields under
// mid-flight AI paint.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { investigation, resetInvestigation } from '../src/lib/investigation.svelte';
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
	type Transport
} from '$lib/net/transport';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { buildBinding, type UnsignedEvent } from '@scrutiny-fabric/core';
import type { NostrEvent } from 'nostr-tools/core';

vi.mock('$lib/net/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/net/transport')>();
	return { ...actual, createTransport: vi.fn() };
});

let openSettle: () => void = () => {};
let settleGate: Promise<void> = Promise.resolve();
let openFill: () => void = () => {};
let fillGate: Promise<void> = Promise.resolve();
/** True when the first record should complete before the fill gate opens. */
let paintBeforeGate = false;

const streamTap = vi.fn(async function* (args: {
	messages: { content: unknown }[];
}): AsyncIterable<string> {
	const parsed = JSON.parse(String(args.messages[0].content)) as { id: string }[];
	const kv = (id: string) => `id: ${id}\ntitle: T-${id}\nsnippet: S-${id}`;
	const [first, ...rest] = parsed;
	if (paintBeforeGate && first !== undefined) yield `${kv(first.id)}\n\n`;
	await fillGate;
	for (const { id } of paintBeforeGate ? rest : parsed) yield `${kv(id)}\n\n`;
});

vi.mock('$lib/ai/gateway', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/ai/gateway')>();
	return {
		...actual,
		streamLLM: (args: { messages: { content: unknown }[] }) => streamTap(args)
	};
});

/** Genuinely-signed events: admission requires a real sig and NIP-01 id. */
const SECRET = generateSecretKey();
function sign(template: { kind: number; created_at: number; tags: string[][]; content: string }): NostrEvent {
	return finalizeEvent(template, SECRET);
}
function forgeProduct(seed: string): NostrEvent {
	return sign({
		kind: 1,
		created_at: 1_780_000_000,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-product'],
			['i', `cve:CVE-${seed}-1`]
		],
		content: `content of ${seed}`
	});
}
function forgeMetadata(seed: string): NostrEvent {
	return sign({
		kind: 1,
		created_at: 1_780_000_001,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-metadata'],
			['i', `cert:${seed}`]
		],
		content: `evidence ${seed}`
	});
}
function forgeBinding(root: string, link: string): NostrEvent {
	const template = buildBinding({ id: root }, { id: link }, 'documents', 1_780_000_002)
		.template as UnsignedEvent;
	return sign({
		kind: template.kind,
		created_at: template.created_at,
		tags: template.tags as string[][],
		content: template.content
	});
}

class GatedTransport implements Transport {
	constructor(
		private readonly searchEvents: NostrEvent[],
		private readonly contextEvents: NostrEvent[]
	) {}
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
	fetch(): Promise<FetchResult> {
		return Promise.reject(new Error('unused'));
	}
	fetchProgressive(): Promise<FetchResult> {
		return Promise.reject(new Error('unused'));
	}
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

const QUESTION = 'cve:CVE-2017-15361';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetInvestigation();
	resetShell();
	settleGate = new Promise<void>((resolve) => {
		openSettle = resolve;
	});
	fillGate = new Promise<void>((resolve) => {
		openFill = resolve;
	});
	streamTap.mockClear();
	paintBeforeGate = false;
	settings.apiKey = 'sk-test-settle-counts';
	settings.model = 'm-settle-counts';
});

afterEach(async () => {
	resetInvestigation();
	resetShell();
	await _closeForTests();
});

describe('settle merge — deterministic counts vs mid-flight AI paint (spec §2 rule 2)', () => {
	it('a card PENDING through the traversal still gets the context-bound metadata count', async () => {
		const product = forgeProduct('p1');
		const metadata = forgeMetadata('CERT-1');
		const binding = forgeBinding(product.id, metadata.id);
		vi.mocked(createTransport).mockReturnValue(new GatedTransport([product], [metadata, binding]));

		const started = investigation.start(QUESTION);
		await vi.waitFor(() => {
			expect(investigation.cards.length).toBe(1);
			expect(investigation.pending.size).toBe(1);
		});

		openSettle();
		openFill();
		await started;

		const card = investigation.cards.find((c) => c.id === product.id);
		expect(card?.boundMetadata).toBe(1);
	});

	it('a card INTERPRETED before the merge keeps its paint AND gains the context count', async () => {
		paintBeforeGate = true;
		const product = forgeProduct('p1');
		const metadata = forgeMetadata('CERT-1');
		const binding = forgeBinding(product.id, metadata.id);
		vi.mocked(createTransport).mockReturnValue(new GatedTransport([product], [metadata, binding]));

		const started = investigation.start(QUESTION);
		await vi.waitFor(() => expect(investigation.cards[0]?.interpreted).toBe(true));

		openSettle();
		openFill();
		await started;

		const card = investigation.cards.find((c) => c.id === product.id);
		expect(card?.interpreted).toBe(true);
		expect(card?.title).toBe(`T-${product.id}`);
		expect(card?.boundMetadata).toBe(1);
	});

	it('a fill pass that settles AFTER the traversal merge cannot write its stale snapshot back', async () => {
		// The lane claims the chunk before the traversal (pre-context card,
		// count 0). The traversal merge then refreshes deterministic facts.
		// Only afterwards does the fill pass paint — and it must paint onto
		// the freshest facts, not onto the snapshot it claimed.
		const product = forgeProduct('p1');
		const metadata = forgeMetadata('CERT-1');
		const binding = forgeBinding(product.id, metadata.id);
		vi.mocked(createTransport).mockReturnValue(new GatedTransport([product], [metadata, binding]));

		const started = investigation.start(QUESTION);
		await vi.waitFor(() => {
			expect(investigation.cards.length).toBe(1);
			expect(investigation.pending.size).toBe(1);
		});

		openSettle();
		await vi.waitFor(() => expect(investigation.cards[0]?.boundMetadata).toBe(1));
		openFill();
		await started;

		const card = investigation.cards.find((c) => c.id === product.id);
		expect(card?.interpreted).toBe(true);
		expect(card?.title).toBe(`T-${product.id}`);
		expect(card?.boundMetadata).toBe(1);
	});
});
