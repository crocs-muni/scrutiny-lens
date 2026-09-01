import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	_closeForTests,
	appendDeadLetter,
	clearAllLocalData,
	deleteSession,
	getInterpretation,
	initPersistence,
	isPersistent,
	listSessions,
	loadDeadLetters,
	loadSettings,
	putSession,
	saveInterpretation,
	saveSettings
} from '$lib/db';
import { clearDeadLetters, deadLetters, hydrateDeadLetters } from '$lib/ai/deadLetter';
import type { DeadLetterEntry } from '$lib/ai/deadLetter';

function letter(at: number): DeadLetterEntry {
	return {
		entityType: 'card',
		entityId: `e${at}`,
		schemaVersion: 'cardvm/1.0',
		profile: 'p',
		model: 'm',
		payload: { at },
		reason: 'test',
		at
	};
}

beforeEach(async () => {
	await clearAllLocalData(); // wipes each test to empty, re-inits to persistent mode
});

afterEach(() => {
	_closeForTests();
});

describe('settings store (spec §6)', () => {
	it('saves and loads a full settings record', async () => {
		await saveSettings({
			endpoint: 'https://llm.ai.e-infra.cz/v1',
			model: 'gpt-x',
			relays: ['wss://a', 'wss://b'],
			appearance: 'dark'
		});
		expect(await loadSettings()).toEqual({
			endpoint: 'https://llm.ai.e-infra.cz/v1',
			model: 'gpt-x',
			relays: ['wss://a', 'wss://b'],
			appearance: 'dark'
		});
	});

	it('merges partial saves instead of overwriting', async () => {
		await saveSettings({ endpoint: 'https://a/v1', model: 'm1' });
		await saveSettings({ appearance: 'system' });
		expect(await loadSettings()).toMatchObject({
			endpoint: 'https://a/v1',
			model: 'm1',
			appearance: 'system'
		});
	});

	it('survives a simulated reload (issue #12 acceptance)', async () => {
		await saveSettings({ endpoint: 'https://a/v1', model: 'm1' });
		_closeForTests();
		await initPersistence();
		expect((await loadSettings())?.model).toBe('m1');
	});
});

describe('interpretations store (key eventId+model)', () => {
	it('keeps card and node surfaces of one event under one key', async () => {
		await saveInterpretation('evt1', 'gpt-x', 'card', { title: 'C' });
		await saveInterpretation('evt1', 'gpt-x', 'node', { title: 'N' });
		const rec = await getInterpretation('evt1', 'gpt-x');
		expect(rec?.bySurface).toEqual({ card: { title: 'C' }, node: { title: 'N' } });
	});

	it('scopes by both key parts', async () => {
		await saveInterpretation('evt1', 'gpt-x', 'card', { title: 'C' });
		expect(await getInterpretation('evt1', 'other-model')).toBeNull();
		expect(await getInterpretation('evt2', 'gpt-x')).toBeNull();
	});
});

describe('sessions store', () => {
	it('puts, lists newest-first, and deletes', async () => {
		await putSession({ id: 's1', title: 'one', createdAt: 100 });
		await putSession({ id: 's2', title: 'two', createdAt: 300 });
		await putSession({ id: 's3', title: 'three', createdAt: 200 });
		expect((await listSessions()).map((s) => s.id)).toEqual(['s2', 's3', 's1']);
		await deleteSession('s3');
		expect((await listSessions()).map((s) => s.id)).toEqual(['s2', 's1']);
	});

	it('updates rows on re-put (unseen flag flip)', async () => {
		await putSession({ id: 's1', title: 'one', createdAt: 100, unseen: true });
		await putSession({ id: 's1', title: 'one', createdAt: 100 });
		expect(await listSessions()).toEqual([{ id: 's1', title: 'one', createdAt: 100 }]);
	});
});

describe('deadLetters ring', () => {
	it('persists and reloads entries chronologically', async () => {
		await appendDeadLetter(letter(1));
		await appendDeadLetter(letter(2));
		expect((await loadDeadLetters()).map((e) => e.at)).toEqual([1, 2]);
	});

	it('caps the ring at 200, keeping the newest', async () => {
		for (let i = 1; i <= 205; i++) await appendDeadLetter(letter(i));
		const rows = await loadDeadLetters();
		expect(rows).toHaveLength(200);
		expect(rows[0].at).toBe(6);
		expect(rows[199].at).toBe(205);
	});

	it('hydrates the sync mirror from the store after a reload', async () => {
		// Awaited put: writeDeadLetter's persist is fire-and-forget by design
		// (spec §6 best-effort), so driving it here would race _closeForTests.
		await appendDeadLetter(letter(1));
		clearDeadLetters(); // simulate reload: mirror gone, store kept
		_closeForTests();
		await initPersistence();
		await hydrateDeadLetters();
		expect(deadLetters().length).toBe(1);
		expect(deadLetters()[0].entityId).toBe('e1');
	});
});

describe('clear-all (spec §6)', () => {
	it('wipes every store and re-opens an empty database', async () => {
		await saveSettings({ model: 'm1' });
		await putSession({ id: 's1', title: 'one', createdAt: 100 });
		await appendDeadLetter(letter(1));
		await clearAllLocalData();
		expect(await loadSettings()).toBeNull();
		expect(await listSessions()).toEqual([]);
		expect(await loadDeadLetters()).toEqual([]);
		expect(isPersistent()).toBe(true);
	});
});

describe('silent degrade (spec §6)', () => {
	it('runs memory-only when IndexedDB is unavailable, without errors', async () => {
		const real = globalThis.indexedDB;
		// @ts-expect-error simulating private-mode absence
		delete globalThis.indexedDB;
		try {
			_closeForTests();
			await initPersistence();
			expect(isPersistent()).toBe(false);
			await saveSettings({ model: 'm1' });
			await putSession({ id: 's1', title: 'one', createdAt: 100 });
			await appendDeadLetter(letter(1));
			expect(await loadSettings()).toBeNull();
			expect(await listSessions()).toEqual([]);
			expect(await loadDeadLetters()).toEqual([]);
			await clearAllLocalData(); // must not throw either
		} finally {
			globalThis.indexedDB = real;
		}
	});
});
