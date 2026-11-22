import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { npubEncode } from 'nostr-tools/nip19';
import {
	initPersistence,
	clearAllLocalData,
	loadTrustOverrides,
	_closeForTests
} from '$lib/db';
import { trust } from '$lib/trust-store.svelte';
import { BUNDLED_TRUSTED } from '$lib/trust';
import { trustSymbol } from '$lib/fabric';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	await trust.reset();
	await trust.flush();
});

afterEach(() => {
	_closeForTests();
});

describe('trust store (spec §2 admission, ADR 0004)', () => {
	it('adds a hex key and admits it', async () => {
		const result = trust.add(KEY_A);
		expect(result).toEqual({ ok: true });
		expect(trust.isTrusted(KEY_A)).toBe(true);
		await trust.flush();
		expect(trust.persistState).toBe('saved');
		const persisted = await loadTrustOverrides();
		expect(persisted?.added).toContain(KEY_A);
	});

	it('accepts an npub and stores the hex form', () => {
		const result = trust.add(npubEncode(KEY_B));
		expect(result).toEqual({ ok: true });
		expect(trust.isTrusted(KEY_B)).toBe(true);
		expect(trust.overrides.added).toContain(KEY_B);
	});

	it('rejects an invalid key with a human message', () => {
		const result = trust.add('not-a-key');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
	});

	it('rejects a duplicate', () => {
		expect(trust.add(KEY_A)).toEqual({ ok: true });
		const duplicate = trust.add(KEY_A);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.message).toMatch(/already/i);
	});

	it('removes a bundled key and re-adds it as an undo', async () => {
		const bundled = BUNDLED_TRUSTED.publishers[0]!.pubkey;
		expect(trust.isTrusted(bundled)).toBe(true);

		await trust.remove(bundled);
		expect(trust.isTrusted(bundled)).toBe(false);
		expect(trust.overrides.removed).toContain(bundled);

		expect(trust.add(bundled)).toEqual({ ok: true });
		expect(trust.isTrusted(bundled)).toBe(true);
		expect(trust.overrides.removed).not.toContain(bundled);
	});

	it('removes a locally added key without touching the bundled list', async () => {
		expect(trust.add(KEY_C)).toEqual({ ok: true });
		await trust.remove(KEY_C);
		expect(trust.overrides.added).not.toContain(KEY_C);
		expect(trust.overrides.removed).not.toContain(KEY_C);
	});

	it('resets to the bundled list', async () => {
		expect(trust.add(KEY_A)).toEqual({ ok: true });
		await trust.remove(BUNDLED_TRUSTED.publishers[0]!.pubkey);

		await trust.reset();
		expect(trust.overrides).toEqual({ added: [], removed: [] });
		expect(trust.publishers.map((publisher) => publisher.pubkey)).toEqual(
			BUNDLED_TRUSTED.publishers.map((publisher) => publisher.pubkey)
		);
	});

	it('exposes a branded fabric provider over the effective set', () => {
		const provider = trust.provider;
		expect(provider[trustSymbol]).toBe(true);
		expect(provider.isTrusted(BUNDLED_TRUSTED.publishers[0]!.pubkey)).toBe(true);
		expect(provider.isTrusted(KEY_A)).toBe(false);
		expect(provider.deltaSince(0)).toBeNull();
	});
});
