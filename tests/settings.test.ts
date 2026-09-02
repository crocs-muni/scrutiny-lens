// Settings flow (issue #11, spec §5/§6): runes state over the #12 settings
// store — defaults → hydrate → persist-on-change; the API key stays
// memory-only and arms the redaction strip on entry.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _closeForTests, clearAllLocalData, dumpAllForTests, initPersistence, loadSettings, putSession } from '$lib/db';
import { defaultSettings, settings, resetSettings } from '../src/lib/settings.svelte';
import { RELAY_MAX, RELAY_MIN } from '../src/lib/config';

const KEY = 'sk-test-1234567890abcdef';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
});

afterEach(() => {
	_closeForTests();
});

describe('hydrate (spec §6: settings survive reload)', () => {
	it('starts from env/config defaults on an empty store', async () => {
		await settings.hydrate();
		expect(settings.endpoint).toBe(defaultSettings.endpoint);
		expect(settings.relays).toEqual(defaultSettings.relays);
		expect(settings.appearance).toBe(defaultSettings.appearance);
	});

	it('merges persisted values over the defaults', async () => {
		await settings.setEndpoint('https://other.example/v1');
		await settings.setAppearance('dark');
		const persisted = await loadSettings();
		expect(persisted?.endpoint).toBe('https://other.example/v1');
		expect(persisted?.appearance).toBe('dark');

		// Reload: fresh state, then hydrate.
		_closeForTests();
		await initPersistence();
		resetSettings();
		await settings.hydrate();
		expect(settings.endpoint).toBe('https://other.example/v1');
		expect(settings.appearance).toBe('dark');
	});

	it('keeps defaults for fields the persisted record does not carry', async () => {
		await settings.setModel('some-model');
		_closeForTests();
		await initPersistence();
		resetSettings();
		await settings.hydrate();
		expect(settings.model).toBe('some-model');
		expect(settings.endpoint).toBe(defaultSettings.endpoint);
	});
});

describe('persist-on-change', () => {
	it('saves every persisted-half change through the store', async () => {
		await settings.setRelays(['wss://a.example', 'wss://b.example', 'wss://c.example']);
		await settings.setModel('llama-x');
		const persisted = await loadSettings();
		expect(persisted?.relays).toEqual(['wss://a.example', 'wss://b.example', 'wss://c.example']);
		expect(persisted?.model).toBe('llama-x');
	});
});

describe('relay list validation (spec §8: 2–4 entries)', () => {
	it('rejects fewer than the minimum', async () => {
		await expect(settings.setRelays(['wss://only.example'])).rejects.toThrow(String(RELAY_MIN));
	});

	it('rejects more than the maximum', async () => {
		await expect(
			settings.setRelays(Array.from({ length: RELAY_MAX + 1 }, (_, i) => `wss://r${i}.example`))
		).rejects.toThrow(String(RELAY_MAX));
	});

	it('rejects duplicates and non-relay URLs', async () => {
		await expect(settings.setRelays(['wss://a', 'wss://a'])).rejects.toThrow('duplicate');
		await expect(settings.setRelays(['https://a', 'wss://b'])).rejects.toThrow('ws');
	});

	it('a rejected list neither mutates state nor persists', async () => {
		const before = [...settings.relays];
		await expect(settings.setRelays(['wss://only.example'])).rejects.toThrow();
		expect(settings.relays).toEqual(before);
		const persisted = await loadSettings();
		expect(persisted?.relays ?? []).not.toEqual(['wss://only.example']);
	});
});

describe('API key (spec §6: memory-only, strip armed)', () => {
	it('is never persisted — store and reload carry no trace', async () => {
		settings.setApiKey(KEY);
		expect(settings.apiKey).toBe(KEY);
		expect(JSON.stringify(await dumpAllForTests())).not.toContain(KEY);

		resetSettings();
		await settings.hydrate();
		expect(settings.apiKey).toBe('');
	});

	it('registerSecret is called when the key is set — later writes are stripped', async () => {
		settings.setApiKey(KEY);
		// Any later write accidentally embedding the key is redacted (spec §6;
		// the db layer only redacts registered secrets — this proves #11 wired it).
		await putSession({ id: 's1', title: `investigation ${KEY} note`, createdAt: 1 });
		expect(JSON.stringify(await dumpAllForTests())).not.toContain(KEY);
	});

	it('clearing the key leaves the strip armed (the value must never appear)', async () => {
		settings.setApiKey(KEY);
		settings.setApiKey('');
		expect(settings.apiKey).toBe('');
		await putSession({ id: 's1', title: `investigation ${KEY} note`, createdAt: 1 });
		expect(JSON.stringify(await dumpAllForTests())).not.toContain(KEY);
	});
});
