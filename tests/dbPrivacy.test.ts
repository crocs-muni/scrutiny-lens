import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	clearAllLocalData,
	dumpAllForTests,
	initPersistence,
	loadSettings,
	registerSecret,
	saveInterpretation,
	saveSettings,
	putSession,
	appendDeadLetter
} from '$lib/db';

const KEY = 'sk-SECRET-DO-NOT-LEAK-12345';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

describe('API key never reaches a stored object (spec §6, ADR-018 pattern)', () => {
	it('strips a registered secret from every write path, nested or not', async () => {
		registerSecret(KEY);
		// Every plausible leak vector through the layer's public write API:
		await saveSettings({ endpoint: `https://api.example.com/v1?key=${KEY}`, model: 'gpt-x' });
		await saveInterpretation('evt1', 'gpt-x', 'card', {
			title: 'NXP JCOP4',
			debug: { echoedAuth: KEY }
		});
		await putSession({ id: 's1', title: `session about ${KEY}`, createdAt: 100 });
		await appendDeadLetter({
			entityType: 'card',
			entityId: 'evt1',
			schemaVersion: 'cardvm/1.0',
			profile: 'p',
			model: 'gpt-x',
			payload: { note: `provider failed, key was ${KEY}` },
			reason: 'test',
			at: 1
		});

		const dump = await dumpAllForTests();
		expect(Object.keys(dump).length).toBeGreaterThan(0); // vacuity guard
		expect(JSON.stringify(dump)).not.toContain(KEY);
	});

	// Red control with an UNREGISTERED marker: proves the positive test above
	// isn't vacuous (the write channel persists what it's given) and documents
	// the contract — registration is mandatory, so #11 must call
	// registerSecret() wherever the key enters the app.
	it('control: an unregistered secret lands in the store', async () => {
		const unregistered = 'sk-UNREGISTERED-marker-67890';
		await putSession({ id: 's2', title: `about ${unregistered}`, createdAt: 100 });
		const dump = await dumpAllForTests();
		expect(JSON.stringify(dump)).toContain(unregistered);
	});

	// Escaped secrets: a key containing " (or \, newline) never appears raw
	// inside JSON.stringify output — the strip must cover the escaped form
	// too, or it leaks verbatim (review H-2).
	it('strips a secret that only exists in JSON-escaped form', async () => {
		const escaped = 'sk-"esc"\\n-key-9876';
		registerSecret(escaped);
		await putSession({ id: 's3', title: `auth ${escaped}`, createdAt: 100 });
		const serialized = JSON.stringify(await dumpAllForTests());
		expect(serialized).not.toContain(escaped);
		expect(serialized).not.toContain(JSON.stringify(escaped).slice(1, -1));
	});

	// Short secrets are refused at registration — otherwise 'sk-123' would
	// redact innocent substrings out of unrelated payloads (review M-5).
	it('refuses to register a short secret', async () => {
		const short = 'sk-123';
		registerSecret(short);
		await putSession({ id: 's4', title: `about ${short}`, createdAt: 100 });
		expect(JSON.stringify(await dumpAllForTests())).toContain(short);
	});

	it('leaves non-secret content untouched', async () => {
		registerSecret(KEY);
		await saveSettings({ endpoint: 'https://api.example.com/v1', model: 'gpt-x' });
		expect(await loadSettings()).toEqual({
			endpoint: 'https://api.example.com/v1',
			model: 'gpt-x'
		});
	});
});
