// Settings flow (issue #11, spec §5/§6): runes state over the #12 settings
// store — defaults → hydrate → persist-on-change; the API key stays
// memory-only and arms the redaction strip on entry.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_closeForTests,
	clearAllLocalData,
	dumpAllForTests,
	initPersistence,
	loadSettings,
	putSession,
	saveSettings
} from '$lib/db';
import { defaultSettings, nextAutoModel, settings, resetSettings } from '../src/lib/settings.svelte';
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

describe('relay list validation (spec §8: 1–4 entries)', () => {
	it('rejects fewer than the minimum', async () => {
		await expect(settings.setRelays([])).rejects.toThrow(String(RELAY_MIN));
	});

	it('rejects more than the maximum', async () => {
		await expect(
			settings.setRelays(Array.from({ length: RELAY_MAX + 1 }, (_, i) => `wss://r${i}.example`))
		).rejects.toThrow(String(RELAY_MAX));
	});

	it('rejects non-relay URLs and folds canonically-equal duplicates', async () => {
		await expect(settings.setRelays(['https://a', 'wss://b'])).rejects.toThrow('ws');
		// Canonical identity (issue #131): `wss://a` and `wss://a/` are ONE
		// relay — the commit collapses them instead of rejecting a list whose
		// every endpoint is real and reachable.
		await settings.setRelays(['wss://a', 'wss://a/']);
		expect(settings.relays).toEqual(['wss://a']);
	});

	it('a rejected list neither mutates state nor persists', async () => {
		const before = [...settings.relays];
		await expect(settings.setRelays([])).rejects.toThrow();
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

describe('single-model auto-select (spec §5)', () => {
	it('fills an empty model when the live list has exactly one entry', () => {
		expect(nextAutoModel(['a'], '', null)).toBe('a');
	});

	it('re-follows when the single model changes and nothing overrode it', () => {
		expect(nextAutoModel(['b'], 'a', 'a')).toBe('b');
	});

	it('leaves the model untouched when the list has no models', () => {
		expect(nextAutoModel([], '', null)).toBeNull();
	});

	it('leaves the model untouched when the list has multiple models', () => {
		expect(nextAutoModel(['a', 'b'], '', null)).toBeNull();
	});

	it('a user pick or stale persisted value is never clobbered by a later fetch', () => {
		// User pick (no auto chain) — and even a chain broken by an override.
		expect(nextAutoModel(['y'], 'x', null)).toBeNull();
		expect(nextAutoModel(['y'], 'x', 'z')).toBeNull();
		// Stale persisted model from a previous session.
		expect(nextAutoModel(['y'], 'old-persisted', null)).toBeNull();
	});
});

describe('ready() boot barrier (WP3)', () => {
	it('two concurrent ready() calls share one memoized hydrate', async () => {
		// resetSettings() (beforeEach) cleared the memo, so this is a cold
		// boot. The two calls must resolve to the SAME promise — the shape
		// single-flight takes when hydration is observably once.
		await saveSettings({ endpoint: 'https://persisted.example/v1', appearance: 'dark' });
		const first = settings.ready();
		const second = settings.ready();
		expect(second).toBe(first); // memoized: same promise, one hydrate
		await Promise.all([first, second]);
		expect(settings.hydrated).toBe(true);
		expect(settings.endpoint).toBe('https://persisted.example/v1');
		expect(settings.appearance).toBe('dark');
	});

	it('a pre-hydration edit survives the barrier (single hydrate does not clobber it)', async () => {
		// The dirty-guard belt + ready() suspenders together: an edit racing
		// the boot barrier keeps the user's value, clean fields still load.
		await saveSettings({ relays: ['wss://persisted-a.example'], appearance: 'dark' });
		resetSettings();
		const barrier = settings.ready();
		await settings.setRelays(['wss://mine.example']);
		await barrier;
		expect(settings.relays).toEqual(['wss://mine.example']);
		expect(settings.appearance).toBe('dark');
	});
});

describe('hydrate dirty guard (WP3)', () => {
	it('does not overwrite relays written before hydration; still hydrates other fields', async () => {
		await saveSettings({
			endpoint: 'https://persisted.example/v1',
			relays: ['wss://persisted-a.example', 'wss://persisted-b.example'],
			appearance: 'dark'
		});
		resetSettings();
		await settings.setRelays(['wss://mine-a.example', 'wss://mine-b.example']);
		await settings.hydrate();
		// Pre-hydration edit wins for relays…
		expect(settings.relays).toEqual(['wss://mine-a.example', 'wss://mine-b.example']);
		// …while clean fields still hydrate from the record.
		expect(settings.endpoint).toBe('https://persisted.example/v1');
		expect(settings.appearance).toBe('dark');
	});
});

describe('save outcomes (WP3, spec §2 never-lie)', () => {
	it("reports 'saved' and folds persistState on a successful write", async () => {
		const outcome = await settings.setRelays(['wss://a.example', 'wss://b.example']);
		expect(outcome).toBe('saved');
		expect(settings.persistState).toBe('saved');
		expect((await loadSettings())?.relays).toEqual(['wss://a.example', 'wss://b.example']);
	});

	it("returns 'unavailable' without throwing when persistence is gone (closed/uninitialised)", async () => {
		// db closed and never re-initialised: db() resolves undefined → the
		// save path must return 'unavailable', never reject, never retry.
		_closeForTests();
		const outcome = await settings.setRelays(['wss://c.example', 'wss://d.example']);
		expect(outcome).toBe('unavailable');
		expect(settings.persistState).toBe('unavailable');
		// No retry happened: after re-init nothing was written for relays.
		await initPersistence();
		expect((await loadSettings())?.relays).toBeUndefined();
	});
});
