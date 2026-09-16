/**
 * Issue #31 cold-open resolution (spec §1 L22, §4, §6, §8): openSharedRecord
 * must resolve the shared root cache-first, then from the hinted relays,
 * report which hints failed, reject non-admissible/non-card records, and
 * fall back to NIP-65 relay discovery and the receiver's configured pool
 * when the link carried no working hints. The admission gate runs on the
 * REAL bytes (fabric admitEvent) — tests forge genuinely-signed SCRUTINY
 * product events (traversal.test.ts recipe).
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	finalizeEvent,
	generateSecretKey,
	getPublicKey
} from 'nostr-tools/pure';
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
 * (empty array = connects ok but holds nothing); absent scripts refuse.
 * Filter-aware like a real relay: kind-10002 relay lists are only served
 * for `{ kinds: [10002] }` queries, everything else only for other filters —
 * a relay asked for one event id must not hand back its author's relay list. */
class FakePool implements PoolLike {
	readonly queried: string[] = [];
	constructor(private readonly scripts: Scripts) {}

	ensureRelay(url: string): Promise<RelayLike> {
		if (this.scripts[url] === undefined) {
			return Promise.reject(new Error(`connection refused by ${url}`));
		}
		return Promise.resolve({ count: async () => 0, close: () => {} });
	}

	querySync(urls: string[], filter: Filter): Promise<NostrEvent[]> {
		this.queried.push(urls[0]);
		const script = this.scripts[urls[0]] ?? [];
		const askForRelayList = filter.kinds?.includes(10002) ?? false;
		return Promise.resolve(
			askForRelayList
				? script.filter((e) => e.kind === 10002)
				: script.filter((e) => e.kind !== 10002)
		);
	}
}

/** Genuinely-signed SCRUTINY product: real key, real NIP-01 id — passes the
 * fabric admitEvent gate (fabric.test.ts selfConsistentProduct recipe). */
function scProduct(overrides: { i?: string } = {}): NostrEvent {
	return scProductBy(generateSecretKey(), overrides);
}

/** Same, with a caller-controlled key — NIP-65 rows must sign the author's
 * kind-10002 relay list with the SAME identity as the shared product. */
function scProductBy(key: Uint8Array, overrides: { i?: string } = {}): NostrEvent {
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
		key
	);
}

/** NIP-65 relay list (kind 10002) signed by `key`: not a SCRUTINY event at
 * all, so no admission applies — the resolver only parses its `r` tags. */
function relayList(key: Uint8Array, tags: string[][]): NostrEvent {
	return finalizeEvent(
		{ kind: 10002, created_at: 1_780_000_002, tags, content: '' },
		key
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

function pointer(id: string, relays: string[] = ['wss://a', 'wss://b'], author?: string): SharePointer {
	return author === undefined ? { id, relays } : { id, relays, author };
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
		settings.relays = ['wss://never-asked'];
		const pool = new FakePool({ 'wss://a': [subject], 'wss://b': [] });
		const res = await openSharedRecord(pointer(subject.id), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual([]);
		// Found at the hint leg → the NIP-65 and configured legs are never
		// reached, even though a configured fallback exists (never-lie:
		// no pointless extra queries for an already-found record, spec §8).
		expect(pool.queried).toEqual(['wss://a', 'wss://b']);
	});

	it('reports hinted relays that failed when the rest still delivered', async () => {
		const subject = scProduct();
		settings.relays = [];
		const pool = new FakePool({ 'wss://dead': undefined, 'wss://live': [subject] });
		const res = await openSharedRecord(pointer(subject.id, ['wss://dead', 'wss://live']), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual(['wss://dead']);
	});

	it('throws not-found naming the failed hints when nothing delivered — an ok-but-empty relay is not a failure', async () => {
		const id = 'be'.repeat(32);
		settings.relays = [];
		const pool = new FakePool({ 'wss://dead': undefined, 'wss://empty': [] });
		const err = await openSharedRecord(pointer(id, ['wss://dead', 'wss://empty']), () => pool).then(
			() => null,
			(e) => e
		);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual(['wss://dead']);
		// wss://empty answered ok — reachable but held nothing: the caller
		// must be told "relays answered, no copy", not "relays failed".
		expect((err as ShareNotFoundError).answeredOk).toBe(true);
	});

	it('lists every refused hinted relay when all of them fail', async () => {
		const id = 'bf'.repeat(32);
		settings.relays = [];
		const pool = new FakePool({ 'wss://a': undefined, 'wss://b': undefined });
		const err = await openSharedRecord(pointer(id), () => pool).then(() => null, (e) => e);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual(['wss://a', 'wss://b']);
		// Every leg refused — no relay was reachable at all.
		expect((err as ShareNotFoundError).answeredOk).toBe(false);
	});

	it('falls back to the receiver’s configured relays when the link carried no hints', async () => {
		const subject = scProduct();
		settings.relays = ['wss://configured'];
		const pool = new FakePool({ 'wss://configured': [subject] });
		const res = await openSharedRecord(pointer(subject.id, []), () => pool);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual([]);
		expect(pool.queried).toEqual(['wss://configured']);
	});

	it('resolves through NIP-65 when every hint died but the author lists a live write relay', async () => {
		const key = generateSecretKey();
		const subject = scProductBy(key);
		settings.relays = ['wss://nip65src'];
		const pool = new FakePool({
			'wss://dead1': undefined,
			'wss://dead2': undefined,
			'wss://nip65src': [relayList(key, [['r', 'wss://nip65write']])],
			'wss://nip65write': [subject]
		});
		const res = await openSharedRecord(
			pointer(subject.id, ['wss://dead1', 'wss://dead2'], subject.pubkey),
			() => pool
		);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual(['wss://dead1', 'wss://dead2']);
		// The shared transport asks hints first (both died → no pushes),
		// then the NIP-65 source for the author's kind-10002 list, then the
		// freshly-discovered write relay for the record — the source relay
		// is asked once, never twice.
		expect(pool.queried).toEqual(['wss://nip65src', 'wss://nip65write']);
	});

	it('falls through to the configured pool when the hints died and the link names no author', async () => {
		const subject = scProduct();
		settings.relays = ['wss://configured'];
		const pool = new FakePool({ 'wss://dead': undefined, 'wss://configured': [subject] });
		const res = await openSharedRecord(
			pointer(subject.id, ['wss://dead'], undefined),
			() => pool
		);

		expect(res.subjectId).toBe(subject.id);
		expect(res.failedHints).toEqual(['wss://dead']);
	});

	it('skips read-only NIP-65 relays and reports not-found honestly when nothing else answers', async () => {
		const key = generateSecretKey();
		const id = 'd0'.repeat(32);
		settings.relays = ['wss://nip65src', 'wss://configured'];
		const pool = new FakePool({
			'wss://dead': undefined,
			// A 'read'-marked r-tag is read-only (NIP-65): never queried
			// for the record, so no write relays exist for this author.
			'wss://nip65src': [relayList(key, [['r', 'wss://readonly', 'read']])],
			'wss://configured': []
		});
		const err = await openSharedRecord(
			pointer(id, ['wss://dead'], getPublicKey(key)),
			() => pool
		).then(() => null, (e) => e);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		// Only wss://dead failed; every other relay answered ok but held
		// nothing — never-lie: reachable, just no copy.
		expect((err as ShareNotFoundError).triedRelays).toEqual(['wss://dead']);
		expect((err as ShareNotFoundError).answeredOk).toBe(true);
	});

	it('lists every refused relay across ALL legs when nothing is reachable anywhere', async () => {
		const key = generateSecretKey();
		const id = 'd1'.repeat(32);
		settings.relays = ['wss://cfg'];
		const pool = new FakePool({
			'wss://hint1': undefined,
			'wss://hint2': undefined,
			'wss://cfg': undefined
		});
		const err = await openSharedRecord(
			pointer(id, ['wss://hint1', 'wss://hint2'], getPublicKey(key)),
			() => pool
		).then(() => null, (e) => e);

		expect(err).toBeInstanceOf(ShareNotFoundError);
		expect((err as ShareNotFoundError).triedRelays).toEqual([
			'wss://hint1',
			'wss://hint2',
			'wss://cfg'
		]);
		// No relay was reachable in any leg — answeredOk stays false.
		expect((err as ShareNotFoundError).answeredOk).toBe(false);
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
