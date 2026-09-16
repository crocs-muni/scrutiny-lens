/**
 * Issue #31 cold-open resolution (spec §1 L22, §4, §6, §8): openSharedRecord
 * must resolve the shared root cache-first, then from the hinted relays,
 * report which hints failed, reject non-admissible/non-card records, and
 * fall back to the receiver's configured pool when the link carried no
 * hints. The admission gate runs on the REAL bytes (fabric admitEvent) —
 * tests forge genuinely-signed SCRUTINY product events (traversal.test.ts
 * recipe).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { openSharedRecord, ShareNotFoundError, ShareRejectedError } from '../src/lib/pipeline/share-open';
import type { SharePointer } from '$lib/share/deep-link';
import type { PoolFactory, PoolLike, RelayLike } from '$lib/net/transport';
import { _closeForTests, clearAllLocalData, initPersistence } from '$lib/db';
import { indexEvent } from '$lib/search';
import { resetSettings, settings } from '$lib/settings.svelte';

/** Relay scripts: url → events to deliver (undefined = refuse to connect). */
type Scripts = Record<string, NostrEvent[] | undefined>;

/** Fake pool mirroring transport.test.ts: each relay resolves to its script
 * (empty array = connects ok but holds nothing); absent scripts refuse. */
class FakePool implements PoolLike {
	readonly queried: string[] = [];
	constructor(private readonly scripts: Scripts) {}

	ensureRelay(url: string): Promise<RelayLike> {
		if (this.scripts[url] === undefined) {
			return Promise.reject(new Error(`connection refused by ${url}`));
		}
		return Promise.resolve({ count: async () => 0, close: () => {} });
	}

	querySync(urls: string[], _filter: Filter): Promise<NostrEvent[]> {
		this.queried.push(urls[0]);
		return Promise.resolve(this.scripts[urls[0]] ?? []);
	}
}

/** Genuinely-signed SCRUTINY product: real key, real NIP-01 id — passes the
 * fabric admitEvent gate (fabric.test.ts selfConsistentProduct recipe). */
function scProduct(overrides: { i?: string } = {}): NostrEvent {
	return finalizeEvent(
		{
			kind: 1,
			created_at: 1_780_000_000,
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-product'],
				['t', 'scrutiny-v0.8.1'],
				...(overrides.i !== undefined ? [['i', overrides.i]] : [])
			],
			content: 'Widget X certificate'
		},
		generateSecretKey()
	);
}

/** Tamper the content AFTER signing — the NIP-01 id no longer recomputes. */
function tampered(original: NostrEvent): NostrEvent {
	return { ...original, content: `${original.content} [tampered]` };
}

/** A chain member (patch/binding) forged standalone — its references are
 * absent, so core holds it pending and the gate must NOT open it as a
 * subject (a dossier subject is a product/metadata card, spec §8). */
function scBinding(): NostrEvent {
	return finalizeEvent(
		{
			kind: 1,
			created_at: 1_780_000_001,
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-binding'],
				['t', 'scrutiny-v0.8.1'],
				['e', 'aa'.repeat(32), '', 'root', 'ab'.repeat(32)]
			],
			content: 'chain patch'
		},
		generateSecretKey()
	);
}

function pointer(id: string, relays: string[] = ['wss://a', 'wss://b']): SharePointer {
	return { id, relays };
}

const HINT_NO_QUERY = (() => {
	throw new Error('pool must not be created on the cache-first path');
}) as unknown as PoolFactory;

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

afterEach(() => {
	resetSettings();
	_closeForTests();
});

describe('openSharedRecord — cold-open resolution (issue #31)', () => {
	it('resolves from the hinted relays when the record is not cached', async () => {
		const subject = scProduct({ i: 'cc-pp:VULN-1' });
		const pool = new FakePool({ 'wss://a': [subject], 'wss://b': [] });
		const res = await openSharedRecord(pointer(subject.id), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual([]);
		// Only the hinted relays are queried — never the whole configured pool.
		expect(pool.queried).toEqual(['wss://a', 'wss://b']);
	});

	it('reports hinted relays that failed when the rest still delivered', async () => {
		const subject = scProduct();
		const pool = new FakePool({ 'wss://dead': undefined, 'wss://live': [subject] });
		const res = await openSharedRecord(pointer(subject.id, ['wss://dead', 'wss://live']), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual(['wss://dead']);
	});

	it('throws not-found naming the failed hints when nothing delivered — an ok-but-empty relay is not a failure', async () => {
		const id = 'be'.repeat(32);
		const pool = new FakePool({ 'wss://dead': undefined, 'wss://empty': [] });
		const err = await openSharedRecord(pointer(id, ['wss://dead', 'wss://empty']), () => pool).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual(['wss://dead']);
	});

	it('lists every refused hinted relay when all of them fail', async () => {
		const id = 'bf'.repeat(32);
		const pool = new FakePool({ 'wss://a': undefined, 'wss://b': undefined });
		const err = await openSharedRecord(pointer(id), () => pool).then(() => null, (e) => e);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual(['wss://a', 'wss://b']);
	});

	it('falls back to the receiver’s configured relays when the link carried no hints', async () => {
		const subject = scProduct();
		settings.relays = ['wss://configured'];
		const pool = new FakePool({ 'wss://configured': [subject] });
		const res = await openSharedRecord(pointer(subject.id, []), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(pool.queried).toEqual(['wss://configured']);
	});

	it('throws not-found with no failed hints when nothing is configured and the link has no hints', async () => {
		settings.relays = [];
		const err = await openSharedRecord(pointer('c0'.repeat(32), []), () => {
			throw new Error('no relays — the pool must never be constructed');
		}).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual([]);
	});

	it('opens from the cache without contacting any relay (spec §6)', async () => {
		const subject = scProduct();
		await indexEvent(subject); // seed the cache like a prior investigation

		const res = await openSharedRecord(
			pointer(subject.id, ['wss://unreachable-hint']),
			HINT_NO_QUERY
		);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual([]);
	});

	it('rejects a tampered record with the honest reason (spec §2 never-lie)', async () => {
		const subject = tampered(scProduct());
		const pool = new FakePool({ 'wss://a': [subject] });
		const err = await openSharedRecord(pointer(subject.id, ['wss://a']), () => pool).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareRejectedError);
		expect((err as Error).message).toContain('does not match');
	});

	it('rejects a non-SCRUTINY event outright', async () => {
		const foreign = finalizeEvent({ kind: 1, created_at: 1_780_000_000, tags: [], content: 'hello' }, generateSecretKey());
		const pool = new FakePool({ 'wss://a': [foreign] });
		const err = await openSharedRecord(pointer(foreign.id, ['wss://a']), () => pool).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareRejectedError);
	});

	it('never opens a chain member (binding/patch) as a subject', async () => {
		const binding = scBinding();
		const pool = new FakePool({ 'wss://a': [binding] });
		const err = await openSharedRecord(pointer(binding.id, ['wss://a']), () => pool).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareRejectedError);
	});

	it('rejects a cached event that fails admission too (gate runs on cache bytes)', async () => {
		const subject = tampered(scProduct());
		await indexEvent(subject); // hostile seed — cached bytes must still be gated
		const err = await openSharedRecord(pointer(subject.id), HINT_NO_QUERY).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareRejectedError);
		expect((err as Error).message).toContain('does not match');
	});
});
