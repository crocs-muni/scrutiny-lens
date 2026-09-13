/**
 * §8.2 traversal fetch tests (lens #68, tools #75): fetchSubjectContext must
 * issue core's exact patch/deletion filters as separate routes (a merged REQ
 * would AND kind-1 patch shape with kind-5 deletion shape and answer nothing,
 * §3.2), then poll deletions for every patch round 1 surfaced (DQ-2).
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { fetchSubjectContext } from '$lib/pipeline/traversal';
import type {
	CountResult,
	FetchResult,
	FetchRoute,
	FetchSlice,
	RelayCapability,
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

		const events = await fetchSubjectContext(subjectId, URLS, transport);

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

		const events = await fetchSubjectContext(subjectId, URLS, transport);

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

		const events = await fetchSubjectContext(subjectId, URLS, transport);

		expect(transport.rounds).toHaveLength(1);
		expect(events.map((e) => e.id).sort()).toEqual([impostor.id, strayDeletion.id].sort());
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

		const events = await fetchSubjectContext(subjectId, URLS, transport);

		expect(events.map((e) => e.id).sort()).toEqual([patch.id, retraction.id].sort());
	});
});
