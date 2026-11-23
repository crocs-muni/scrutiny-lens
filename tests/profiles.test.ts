/**
 * Issue #131 WP7 (spec §2 never-lie, §9): a kind-0 lookup's answer belongs to
 * the relay pool that produced it. These specs pin the three-state contract —
 * found / asked-and-empty / never-asked — the pool-scoped cache (a miss earned
 * under pool A is never replayed under pool B), and the boot barrier (lookups
 * must not fire against pre-hydration default relays).
 *
 * The component itself cannot mount in the node test project (no DOM), so the
 * chip's found/missing/unasked decision is asserted through the exported pure
 * mapping profileClaim; the browser-only rendering is left to the a11y/manual
 * pass.
 *
 * #135 adds the local-first half: a kind-0 this device already resolved is a
 * device row (IndexedDB), so a reloaded tab — the cache-restored card case —
 * paints the same avatar + name with zero relay traffic, and an author no row
 * and no relay knows still lands on the deterministic identicon + npub token.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import {
	_closeForTests,
	clearAllLocalData,
	initPersistence,
	loadProfile,
	saveSettings
} from '$lib/db';
import { resetSettings, settings } from '$lib/settings.svelte';
import { getProfile, profileClaim, resetProfiles } from '../src/lib/net/profiles';
import {
	identiconCells,
	publisherHue,
	publisherNpub,
	publisherToken
} from '../src/lib/publisher';

/** Fake relay cloud shared with the module mock below. vi.hoisted runs before
 * the mocked module is imported, so the factory can close over it. */
const fake = vi.hoisted(() => ({
	/** One entry per SimplePool.querySync the seam actually issued. */
	queries: [] as { relays: string[]; filter: Filter }[],
	/** What the fake relays hold for a query (default: nothing). */
	respond: (_relays: string[], _filter: Filter): NostrEvent[] => [],
	destroyed: 0
}));

// The seam constructs SimplePool directly (no injectable transport), so the
// relay cloud is faked at module level — one fake for every pool instance.
vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		querySync(relays: string[], filter: Filter): Promise<NostrEvent[]> {
			fake.queries.push({ relays: [...relays], filter });
			return Promise.resolve(fake.respond(relays, filter));
		}
		destroy(): void {
			fake.destroyed += 1;
		}
	}
}));

const POOL_A = ['wss://relay-a.example', 'wss://relay-b.example'];
const POOL_B = ['wss://relay-c.example', 'wss://relay-d.example'];

const SK = generateSecretKey();
const PUBKEY = getPublicKey(SK);

/** Real signed kind-0 event: the seam parses real NIP-01 content. */
function kind0(content: Record<string, unknown>): NostrEvent {
	return finalizeEvent(
		{ kind: 0, created_at: 1_700_000_000, tags: [], content: JSON.stringify(content) },
		SK
	);
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
	resetProfiles();
	fake.queries.length = 0;
	fake.destroyed = 0;
	fake.respond = () => [];
});

afterEach(() => {
	_closeForTests();
});

describe('pool-scoped profile lookup (issue #131 WP7)', () => {
	it('serves a cached miss under the same pool without a second query', async () => {
		settings.relays = [...POOL_A];

		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(1);
		expect(fake.queries[0].relays).toEqual(POOL_A);
		expect(fake.queries[0].filter).toEqual({ kinds: [0], authors: [PUBKEY], limit: 1 });
		expect(fake.destroyed).toBe(1);

		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(1);
	});

	it('re-queries the same pubkey under a different pool', async () => {
		settings.relays = [...POOL_A];
		expect(await getProfile(PUBKEY)).toBeNull();

		fake.respond = (relays) =>
			relays[0] === POOL_B[0] ? [kind0({ name: 'Alice', picture: 'https://img/x.png' })] : [];
		settings.relays = [...POOL_B];

		expect(await getProfile(PUBKEY)).toEqual({
			name: 'Alice',
			picture: 'https://img/x.png'
		});
		expect(fake.queries).toHaveLength(2);
		expect(fake.queries[1].relays).toEqual(POOL_B);

		// #135 changed what crosses pools: a MISS is a fact about the relays
		// and stays pool-scoped, but a HIT is a signed kind-0 this device saw,
		// so the stored row answers under any pool without asking again.
		// (Before the device snapshot existed, A replayed its own miss and the
		// chip stayed blank even though the author had been resolved.)
		settings.relays = [...POOL_A];
		expect(await getProfile(PUBKEY)).toEqual({
			name: 'Alice',
			picture: 'https://img/x.png'
		});
		expect(fake.queries).toHaveLength(2);
	});

	it('refresh bypasses the stored snapshot and replaces the name', async () => {
		settings.relays = [...POOL_A];
		fake.respond = () => [kind0({ name: 'Alice', picture: 'https://img/x.png' })];
		expect(await getProfile(PUBKEY)).toEqual({
			name: 'Alice',
			picture: 'https://img/x.png'
		});

		// A reload keeps the device row but loses the tab memo.
		resetProfiles();
		fake.respond = () => [kind0({ name: 'Bob', picture: 'https://img/y.png' })];
		expect(await getProfile(PUBKEY)).toEqual({
			name: 'Alice',
			picture: 'https://img/x.png'
		});
		expect(fake.queries).toHaveLength(1);

		expect(await getProfile(PUBKEY, { refresh: true })).toEqual({
			name: 'Bob',
			picture: 'https://img/y.png'
		});
		expect(fake.queries).toHaveLength(2);

		// The refresh updated the memo, so the normal path answers the new name.
		expect(await getProfile(PUBKEY)).toEqual({
			name: 'Bob',
			picture: 'https://img/y.png'
		});
		expect(fake.queries).toHaveLength(2);
	});

	it('answers undefined for an empty pool and asks nothing', async () => {
		settings.relays = [];

		expect(await getProfile(PUBKEY)).toBeUndefined();
		expect(fake.queries).toHaveLength(0);
		expect(fake.destroyed).toBe(0);

		// The unasked result must not be cached as a miss for a real pool.
		settings.relays = [...POOL_A];
		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(1);
	});

	it('shares one in-flight fetch between concurrent callers of one pool', async () => {
		settings.relays = [...POOL_A];

		const [a, b] = await Promise.all([getProfile(PUBKEY), getProfile(PUBKEY)]);
		expect(a).toBeNull();
		expect(b).toBeNull();
		expect(fake.queries).toHaveLength(1);
	});

	it('treats a malformed kind-0 as an honest miss, not a profile', async () => {
		settings.relays = [...POOL_A];
		fake.respond = () => [
			finalizeEvent({ kind: 0, created_at: 1_700_000_000, tags: [], content: 'not json' }, SK)
		];

		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.destroyed).toBe(1);
	});

	it('re-asks after resetProfiles even under the same pool', async () => {
		settings.relays = [...POOL_A];
		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(1);

		resetProfiles();
		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(2);
	});

	it('awaits the boot barrier: hydration decides the pool, not the defaults', async () => {
		await saveSettings({ relays: [...POOL_B] });
		// Simulate a reload: fresh connection, fresh state, fresh barrier.
		_closeForTests();
		await initPersistence();
		resetSettings();
		resetProfiles();
		fake.queries.length = 0;

		expect(await getProfile(PUBKEY)).toBeNull();
		expect(fake.queries).toHaveLength(1);
		expect(fake.queries[0].relays).toEqual(POOL_B);
		expect(settings.hydrated).toBe(true);
	});
});

describe('profileClaim (what the chip is allowed to say)', () => {
	it('maps found / missing / unasked without collapsing them', () => {
		expect(profileClaim({ name: 'Alice', picture: null })).toBe('found');
		expect(profileClaim({ name: null, picture: 'https://img/x.png' })).toBe('found');
		expect(profileClaim(null)).toBe('missing');
		expect(profileClaim(undefined)).toBe('unasked');
	});
});

/** A reload: the tab's memo and settings die, the device's rows do not
 * (issue #83's restore is exactly this seam). */
async function reload(): Promise<void> {
	_closeForTests();
	await initPersistence();
	resetSettings();
	resetProfiles();
	fake.queries.length = 0;
}

const ALICE = { name: 'Alice', picture: 'https://img/x.png' };

describe('cache-restored cards keep their publisher identity (issue #135)', () => {
	it('paints a previously resolved profile from the device, asking no relay', async () => {
		settings.relays = [...POOL_A];
		fake.respond = () => [kind0(ALICE)];
		expect(await getProfile(PUBKEY)).toEqual(ALICE);
		expect(fake.queries).toHaveLength(1);

		// The write-through is fire-and-forget; a reload must still find the row.
		await vi.waitFor(async () => expect(await loadProfile(PUBKEY)).not.toBeNull());
		await reload();
		// This session's relays know nothing (cache-restored run, or offline):
		// without the device row the chip would go bare, which IS the bug.
		fake.respond = () => [];

		expect(await getProfile(PUBKEY)).toEqual(ALICE);
		expect(fake.queries).toHaveLength(0);
	});

	it('a stored snapshot answers under a different pool (it is a fact about the author)', async () => {
		settings.relays = [...POOL_A];
		fake.respond = () => [kind0(ALICE)];
		expect(await getProfile(PUBKEY)).toEqual(ALICE);
		await vi.waitFor(async () => expect(await loadProfile(PUBKEY)).not.toBeNull());

		await reload();
		fake.respond = () => [];
		settings.relays = [...POOL_B];
		expect(await getProfile(PUBKEY)).toEqual(ALICE);
		expect(fake.queries).toHaveLength(0);
	});

	it('a restored cohort asks once per UNKNOWN author and never for a stored one', async () => {
		settings.relays = [...POOL_A];
		fake.respond = (_relays, filter) =>
			filter.authors?.[0] === PUBKEY ? [kind0(ALICE)] : [];
		expect(await getProfile(PUBKEY)).toEqual(ALICE);
		await vi.waitFor(async () => expect(await loadProfile(PUBKEY)).not.toBeNull());

		await reload();
		const unknown = [
			getPublicKey(generateSecretKey()),
			getPublicKey(generateSecretKey())
		];
		// One query each for the two strangers — the bound the acceptance line
		// names — and the stored author comes back without touching a relay.
		const results = await Promise.all([
			getProfile(PUBKEY),
			...unknown.map((pubkey) => getProfile(pubkey))
		]);
		expect(results[0]).toEqual(ALICE);
		expect(results.slice(1)).toEqual([null, null]);
		expect(fake.queries).toHaveLength(2);
		expect(fake.queries.map((q) => q.filter.authors?.[0])).toEqual(expect.arrayContaining(unknown));
	});
});

describe('an unresolvable author falls back deterministically (issue #135)', () => {
	const stranger = getPublicKey(generateSecretKey());

	it('resolves an honest miss and invents no device row', async () => {
		settings.relays = [...POOL_A];
		fake.respond = () => [];

		expect(await getProfile(stranger)).toBeNull();
		expect(profileClaim(null)).toBe('missing');
		// A miss is not evidence about the author — nothing gets written.
		expect(await loadProfile(stranger)).toBeNull();
	});

	it('derives a non-empty npub token and the same identicon on every load', () => {
		const npub = publisherNpub(stranger);
		const token = publisherToken(npub);
		expect(token).not.toBe('');
		expect(token.startsWith('npub1')).toBe(true);
		expect(publisherToken(npub)).toBe(token);

		const cells = identiconCells(publisherHue(stranger));
		expect(cells).toHaveLength(5);
		expect(cells.every((row) => row.length === 5)).toBe(true);
		// Mirrored by construction, so the 16px icon reads as one glyph — and
		// keyed by the author, so a reload redraws the same one (the icon is a
		// 9-bit grid: uniqueness across authors is not promised).
		for (const row of cells) expect(row).toEqual([...row].reverse());
		expect(identiconCells(publisherHue(stranger))).toEqual(cells);
	});

	it('degrades a malformed author id instead of throwing', () => {
		expect(publisherNpub('not-hex')).toBe('not-hex');
		expect(publisherToken(publisherNpub('not-hex'))).not.toBe('');
	});
});
