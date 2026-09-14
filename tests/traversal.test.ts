/**
 * §8.2 traversal fetch tests (lens #68, tools #75): fetchSubjectContext must
 * issue core's exact patch/deletion filters as separate routes (a merged REQ
 * would AND kind-1 patch shape with kind-5 deletion shape and answer nothing,
 * §3.2), then poll deletions for every patch round 1 surfaced (DQ-2). The
 * settle-pass suite covers the bindings legs + full DQ-2 polling + failure
 * visibility (lens #68 completion).
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
	fetchSessionContext,
	fetchSubjectContext,
	fetchSubjectDeletions,
	boundContextIds,
	traversalNoticeText,
	SECOND_HOP_ID_CAP
} from '$lib/pipeline/traversal';
import type {
	CountResult,
	FetchResult,
	FetchRoute,
	FetchSlice,
	RelayCapability,
	RelayStatus,
	Transport
} from '$lib/net/transport';

const URLS = ['wss://relay-a', 'wss://relay-b'];

/** Genuinely-signed synthetic event: real key, real NIP-01 id — the shape
 * scrutinyEventType and the admission gates expect to read. */
function forge(kind: number, tags: string[][], content = ''): NostrEvent {
	return finalizeEvent({ kind, created_at: 1_780_000_000, tags, content }, generateSecretKey());
}

/** Chain patch rooted at (and optionally replying to) the given ids. */
function patchOn(rootId: string, replyId: string = rootId): NostrEvent {
	return forge(
		1,
		[
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-patch'],
			['e', rootId, '', 'root', ''],
			['e', replyId, '', 'reply', '']
		],
		'--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new'
	);
}

function deletionOf(targetId: string): NostrEvent {
	return forge(5, [['e', targetId]]);
}

/** Records each fetchRouted round; answers come back per route label. */
class StubTransport implements Transport {
	readonly rounds: FetchRoute[][] = [];
	constructor(private readonly answers: Map<string, NostrEvent[]>) {}
	async fetchRouted(routes: FetchRoute[], _onSlice: (s: FetchSlice) => void): Promise<FetchResult> {
		this.rounds.push(routes);
		const events: NostrEvent[] = [];
		const seen = new Set<string>();
		for (const route of routes) {
			for (const event of this.answers.get(route.label) ?? []) {
				if (seen.has(event.id)) continue;
				seen.add(event.id);
				events.push(event);
			}
		}
		return { events, relays: [] };
	}
	fetch(_filters: Filter[]): Promise<FetchResult> {
		return Promise.reject(new Error('unused'));
	}
	fetchProgressive(_filters: Filter[], _onSlice: (s: FetchSlice) => void): Promise<FetchResult> {
		return Promise.reject(new Error('unused'));
	}
	count(_filters: Filter[]): Promise<CountResult> {
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

/** StubTransport with scripted per-round relay statuses — failures must be
 * observable in `rounds`, not just as thrown errors. */
class StatusTransport extends StubTransport {
	constructor(
		answers: Map<string, NostrEvent[]>,
		private readonly roundRelays: RelayStatus[][]
	) {
		super(answers);
	}
	override async fetchRouted(routes: FetchRoute[], onSlice: (s: FetchSlice) => void): Promise<FetchResult> {
		const result = await super.fetchRouted(routes, onSlice);
		const relays = this.roundRelays.shift() ?? result.relays;
		return { ...result, relays };
	}
}

describe('fetchSubjectContext (§8.2, tools #75)', () => {
	it('round 1 issues core’s exact patch and subject-deletion filters as two separate routes', async () => {
		const subjectId = 'ab'.repeat(32);
		const transport = new StubTransport(new Map());

		await fetchSubjectContext(subjectId, URLS, transport);

		expect(transport.rounds).toHaveLength(1);
		expect(transport.rounds[0]).toEqual([
			{
				label: 'traversal:patches',
				urls: URLS,
				filters: [{ kinds: [1], '#t': ['scrutiny-patch'], '#e': [subjectId] }]
			},
			{
				label: 'traversal:deletions:subject',
				urls: URLS,
				filters: [{ kinds: [5], '#e': [subjectId] }]
			}
		]);
	});

	it('round 2 polls deletionsFor every patch round 1 surfaced (DQ-2)', async () => {
		const subjectId = 'ab'.repeat(32);
		const parent = patchOn(subjectId);
		const child = patchOn(subjectId, parent.id);
		const transport = new StubTransport(
			new Map([['traversal:patches', [parent, child]]])
		);

	const events = (await fetchSubjectContext(subjectId, URLS, transport)).events;

		expect(transport.rounds).toHaveLength(2);
		expect(transport.rounds[1]).toEqual([
			{
				label: `traversal:deletions:patch:${parent.id}`,
				urls: URLS,
				filters: [{ kinds: [5], '#e': [parent.id] }]
			},
			{
				label: `traversal:deletions:patch:${child.id}`,
				urls: URLS,
				filters: [{ kinds: [5], '#e': [child.id] }]
			}
		]);
		expect(events.map((e) => e.id).sort()).toEqual([parent.id, child.id].sort());
	});

	it('skips round 2 when the relay holds no patches — and still returns the subject’s own deletions', async () => {
		const subjectId = 'ab'.repeat(32);
		const retraction = deletionOf(subjectId);
		const transport = new StubTransport(
			new Map([['traversal:deletions:subject', [retraction]]])
		);

	const events = (await fetchSubjectContext(subjectId, URLS, transport)).events;

		expect(transport.rounds).toHaveLength(1);
		expect(events.map((e) => e.id)).toEqual([retraction.id]);
	});

	it('never polls deletions for untrusted junk the patch filter answered with', async () => {
		const subjectId = 'ab'.repeat(32);
		// Not patch-shaped: kind-1 without the scrutiny-patch type tag, and a
		// kind-5. Neither may spawn a deletionsFor REQ of its own id.
		const impostor = forge(1, [['e', subjectId, '', 'reply', '']]);
		const strayDeletion = deletionOf(subjectId);
		const transport = new StubTransport(
			new Map([['traversal:patches', [impostor, strayDeletion]]])
		);

	const events = (await fetchSubjectContext(subjectId, URLS, transport)).events;

		expect(transport.rounds).toHaveLength(1);
		expect(events.map((e) => e.id).sort()).toEqual([impostor.id, strayDeletion.id].sort());
	});

	it('never polls deletions for a patch-shaped answer that is not anchored at this subject (DQ-4)', async () => {
		const subjectId = 'ab'.repeat(32);
		const otherRootId = 'cd'.repeat(32);
		// PT-valid patch of ANOTHER chain that a bugged/hostile relay slipped
		// into the answer — classifyByRole must not bind it to this subject.
		const foreignPatch = patchOn(otherRootId);
		// Patch-shaped and names the subject, but the naming tag is UNMARKED —
		// DQ-4 asks for a role, and an unmarked tag carries none.
		const unmarked = forge(
			1,
			[
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-v0.8.1'],
				['t', 'scrutiny-patch'],
				['e', subjectId, '', '', '']
			],
			'--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new'
		);
		const transport = new StubTransport(
			new Map([['traversal:patches', [foreignPatch, unmarked]]])
		);

	const events = (await fetchSubjectContext(subjectId, URLS, transport)).events;

		expect(transport.rounds).toHaveLength(1);
		expect(events.map((e) => e.id).sort()).toEqual([foreignPatch.id, unmarked.id].sort());
	});

	it('dedupes a deletion that arrives in both rounds', async () => {
		const subjectId = 'ab'.repeat(32);
		const patch = patchOn(subjectId);
		const retraction = deletionOf(patch.id);
		const transport = new StubTransport(
			new Map([
				['traversal:patches', [patch, retraction]],
				[`traversal:deletions:patch:${patch.id}`, [retraction]]
			])
		);

	const events = (await fetchSubjectContext(subjectId, URLS, transport)).events;

		expect(events.map((e) => e.id).sort()).toEqual([patch.id, retraction.id].sort());
	});
});

// ── Session-settle traversal (lens #68, bindings + DQ-2 completion) ─────────

/** Product/metadata node with the usual fabric type tags. */
function node(typeTag: 'scrutiny-product' | 'scrutiny-metadata'): NostrEvent {
	return forge(1, [
		['t', 'scrutiny-fabric'],
		['t', 'scrutiny-v0.8.1'],
		['t', typeTag],
		['i', `test:${typeTag}-${Math.random().toString(36).slice(2, 8)}`]
	]);
}

/** Binding between a product and a metadata event. */
function bindingBetween(rootId: string, linkId: string): NostrEvent {
	return forge(
		1,
		[
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-binding'],
			['e', rootId, '', 'root', ''],
			['e', linkId, '', 'link', '']
		],
		'documents'
	);
}

describe('fetchSessionContext (§8.2, lens #68 — bindings legs)', () => {
	it('round 1 unions one bindingsReferencing filter per product/metadata id and one deletionsFor filter per admitted id — two separate routes', async () => {
		const product = node('scrutiny-product');
		const meta = node('scrutiny-metadata');
		const transport = new StubTransport(new Map());

		await fetchSessionContext([product, meta], URLS, transport);

		expect(transport.rounds).toHaveLength(1);
		expect(transport.rounds[0]).toEqual([
			{
				label: 'traversal:bindings',
				urls: URLS,
				filters: [
					{ kinds: [1], '#t': ['scrutiny-binding'], '#e': [product.id] },
					{ kinds: [1], '#t': ['scrutiny-binding'], '#e': [meta.id] }
				]
			},
			{
				label: 'traversal:deletions',
				urls: URLS,
				filters: [
					{ kinds: [5], '#e': [product.id] },
					{ kinds: [5], '#e': [meta.id] }
				]
			}
		]);
	});

	it('round 2 fetches each bound binding’s missing endpoints by id and polls deletions for every new arrival', async () => {
		const product = node('scrutiny-product');
		const meta = node('scrutiny-metadata'); // NOT part of the session
		const binding = bindingBetween(product.id, meta.id);
		const transport = new StubTransport(
			new Map([['traversal:bindings', [binding]]])
		);

		const result = await fetchSessionContext([product], URLS, transport);

		expect(transport.rounds).toHaveLength(2);
		expect(transport.rounds[1]).toEqual([
			{
				label: 'traversal:bindings:endpoints',
				urls: URLS,
				filters: [{ ids: [meta.id] }]
			},
			{
				label: 'traversal:deletions:arrivals',
				urls: URLS,
				filters: [
					{ kinds: [5], '#e': [binding.id] },
					{ kinds: [5], '#e': [meta.id] }
				]
			}
		]);
		expect(result.events.map((e) => e.id)).toEqual([binding.id]);
		expect(result.capped).toBe(0);
	});

	it('returns round-2 events and does not refetch a counterparty the relay already delivered in round 1', async () => {
		const product = node('scrutiny-product');
		const meta = node('scrutiny-metadata');
		const binding = bindingBetween(product.id, meta.id);
		// The relays handed back the metadata along with the binding.
		const transport = new StubTransport(
			new Map([['traversal:bindings', [binding, meta]]])
		);

		const result = await fetchSessionContext([product], URLS, transport);

		expect(transport.rounds).toHaveLength(2);
		expect(transport.rounds[1]).toEqual([
			{
				label: 'traversal:deletions:arrivals',
				urls: URLS,
				filters: [
					{ kinds: [5], '#e': [binding.id] },
					{ kinds: [5], '#e': [meta.id] }
				]
			}
		]);
		expect(result.events.map((e) => e.id).sort()).toEqual([binding.id, meta.id].sort());
	});

	it('spawns no second hop for a binding whose endpoints do not name an admitted node (DQ-4)', async () => {
		const product = node('scrutiny-product');
		const foreignRoot = node('scrutiny-product'); // not this session's node
		const foreignLink = node('scrutiny-metadata');
		const strayBinding = bindingBetween(foreignRoot.id, foreignLink.id);
		// Marker-deficient: two roots, no link — bindingEndpoints must reject it.
		const malformed = forge(1, [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-binding'],
			['e', product.id, '', 'root', ''],
			['e', foreignRoot.id, '', 'root', '']
		]);
		const transport = new StubTransport(
			new Map([['traversal:bindings', [strayBinding, malformed]]])
		);

		const result = await fetchSessionContext([product], URLS, transport);

		// Both arrive back as fetched context (admission judges them later),
		// but neither may spawn endpoint REQs or deletion polls.
		expect(transport.rounds).toHaveLength(1);
		expect(result.events.map((e) => e.id).sort()).toEqual(
			[strayBinding.id, malformed.id].sort()
		);
	});

	it('caps the second hop at 128 endpoint ids, deterministically ordered, and reports the capped count', async () => {
		const product = node('scrutiny-product');
		const bindings = Array.from({ length: SECOND_HOP_ID_CAP + 3 }, () =>
			bindingBetween(product.id, 'ff'.repeat(32))
		);
		// Distinct endpoint ids so nothing dedupes below the cap.
		bindings.forEach((b, i) => {
			const tags = b.tags.slice(0, -1);
			tags.push(['e', `${String(i).padStart(64, '0')}`, '', 'link', '']);
			// Re-forge so ids recompute over the changed tags.
			Object.assign(b, forge(1, tags, b.content));
		});
		const transport = new StubTransport(
			new Map([['traversal:bindings', bindings]])
		);

		const result = await fetchSessionContext([product], URLS, transport);

		const idsRoute = transport.rounds[1].find(
			(r) => r.label === 'traversal:bindings:endpoints'
		);
		expect(idsRoute?.filters[0].ids).toHaveLength(SECOND_HOP_ID_CAP);
		expect(result.capped).toBe(3);
	});

	it('reports per-round relay statuses so the caller can compose an honest notice', async () => {
		const product = node('scrutiny-product');
		const transport = new StatusTransport(new Map(), [
			[
				{ url: URLS[0], status: 'ok', count: 0 },
				{ url: URLS[1], status: 'refused', count: 0 }
			]
		]);

		const result = await fetchSessionContext([product], URLS, transport);

		expect(result.rounds).toEqual([
			{
				label: 'traversal:round1',
				relays: [
					{ url: URLS[0], status: 'ok', count: 0 },
					{ url: URLS[1], status: 'refused', count: 0 }
				]
			}
		]);
	});
});

describe('boundContextIds (DQ-4, core classifyByRole)', () => {
	it('lists the patches and bindings classifyByRole binds to the subject — never foreign or unmarked events', () => {
		const subject = node('scrutiny-product');
		const patch = patchOn(subject.id);
		const foreignPatch = patchOn('ee'.repeat(32));
		const meta = node('scrutiny-metadata');
		const binding = bindingBetween(subject.id, meta.id);
		const foreignBinding = bindingBetween('ee'.repeat(32), meta.id);
		const unmarked = forge(1, [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-binding'],
			['e', subject.id, '', '', '']
		]);

		const ids = boundContextIds([subject, patch, foreignPatch, binding, foreignBinding, unmarked], subject.id);

		expect(ids.sort()).toEqual([patch.id, binding.id].sort());
	});
});

describe('fetchSubjectDeletions (DQ-2 re-poll)', () => {
	it('issues ONE unioned route over the subject and its bound context ids', async () => {
		const subject = node('scrutiny-product');
		const patch = patchOn(subject.id);
		const meta = node('scrutiny-metadata');
		const binding = bindingBetween(subject.id, meta.id);
		const transport = new StubTransport(new Map());

		await fetchSubjectDeletions(subject.id, [patch.id, binding.id], URLS, transport);

		expect(transport.rounds).toEqual([
			[
				{
					label: 'traversal:deletions:repoll',
					urls: URLS,
					filters: [
						{ kinds: [5], '#e': [subject.id] },
						{ kinds: [5], '#e': [patch.id] },
						{ kinds: [5], '#e': [binding.id] }
					]
				}
			]
		]);
	});
});

describe('traversalNoticeText (§4 honesty lane)', () => {
	it('silent when every covered relay answered ok', () => {
		const ok = [{ url: URLS[0], status: 'ok' as const, count: 0 }];
		expect(traversalNoticeText([{ label: 'traversal:round1', relays: ok }])).toBeUndefined();
	});

	it('names every relay dead — context fetch failed', () => {
		expect(
			traversalNoticeText([
				{
					label: 'traversal:round1',
					relays: [
						{ url: URLS[0], status: 'refused', count: 0 },
						{ url: URLS[1], status: 'timeout', count: 0 }
					]
				}
			])
		).toBe(
			'context fetch failed — all relays unreachable — Files counts and retraction pills may be incomplete'
		);
	});

	it('names some relays dead — skipped, numeric, names the stakes', () => {
		expect(
			traversalNoticeText([
				{
					label: 'traversal:round1',
					relays: [
						{ url: URLS[0], status: 'ok', count: 1 },
						{ url: URLS[1], status: 'refused', count: 0 }
					]
				}
			])
		).toBe(
			'context fetch skipped 1 of 2 relays — Files counts and retraction pills may be incomplete'
		);
	});

	it('a relay dead in ANY round counts as skipped across the union of covered relays', () => {
		expect(
			traversalNoticeText([
				{
					label: 'traversal:round1',
					relays: [
						{ url: URLS[0], status: 'ok', count: 0 },
						{ url: URLS[1], status: 'ok', count: 0 }
					]
				},
				{
					label: 'traversal:round2',
					relays: [
						{ url: URLS[0], status: 'timeout', count: 0 },
						{ url: URLS[1], status: 'ok', count: 0 }
					]
				}
			])
		).toBe(
			'context fetch skipped 1 of 2 relays — Files counts and retraction pills may be incomplete'
		);
	});
});
