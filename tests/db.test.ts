import 'fake-indexeddb/auto';
import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	DB_NAME,
	DB_VERSION,
	_closeForTests,
	appendDeadLetter,
	clearAllLocalData,
	deleteSession,
	dumpAllForTests,
	getEventsByTag,
	getInterpretation,
	initPersistence,
	isPersistent,
	listEvents,
	listSessions,
	loadDeadLetters,
	loadSettings,
	putSession,
	saveInterpretation,
	saveSettings,
	type PersistedSettings
} from '$lib/db';
import { clearDeadLetters, deadLetters, hydrateDeadLetters, writeDeadLetter } from '$lib/ai/deadLetter';
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
	await initPersistence();
	await clearAllLocalData();
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
		// cross-wiring guard: the row must actually live in the settings store
		expect((await dumpAllForTests()).settings).toHaveLength(1);
	});

	it('merges concurrent patches without losing one (review T-1)', async () => {
		await Promise.all([
			saveSettings({ appearance: 'dark' }),
			saveSettings({ endpoint: 'https://a/v1', model: 'm1' })
		]);
		expect(await loadSettings()).toEqual({
			appearance: 'dark',
			endpoint: 'https://a/v1',
			model: 'm1'
		});
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

	it('merges surfaces written concurrently without losing one (review H-3)', async () => {
		await Promise.all([
			saveInterpretation('evtC', 'm', 'card', { a: 1 }),
			saveInterpretation('evtC', 'm', 'node', { b: 2 })
		]);
		expect((await getInterpretation('evtC', 'm'))?.bySurface).toEqual({
			card: { a: 1 },
			node: { b: 2 }
		});
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

	it('trims by append order, not by `at` (contract pin, review T-4)', async () => {
		// Out-of-order `at` values: the ring keeps the most recently APPENDED,
		// even when an early-appended entry carries a later timestamp.
		for (const at of [100, 5, 50]) await appendDeadLetter(letter(at));
		expect((await loadDeadLetters()).map((e) => e.at)).toEqual([100, 5, 50]);
	});

	it('keeps a boot entry stamped at the SAME ms as the last persisted (review T-3)', async () => {
		const at = Date.now();
		await appendDeadLetter(letter(at));
		clearDeadLetters();
		writeDeadLetter({
			entityType: 'card',
			entityId: 'boot-same-ms',
			schemaVersion: 'v',
			profile: 'p',
			model: 'm',
			payload: {},
			reason: 'r'
		});
		// Force the boot entry to the exact boundary timestamp — immune to
		// clock drift between the two stamping operations.
		deadLetters()[0].at = at;
		await hydrateDeadLetters();
		expect(deadLetters().map((e) => e.entityId)).toEqual([`e${at}`, 'boot-same-ms']);
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
	it('keeps boot-window mirror entries when hydrating (review L-8)', async () => {
		await appendDeadLetter(letter(1));
		writeDeadLetter({
			entityType: 'card',
			entityId: 'boot',
			schemaVersion: 'v',
			profile: 'p',
			model: 'm',
			payload: {},
			reason: 'r'
		});
		await hydrateDeadLetters();
		expect(deadLetters().map((e) => e.entityId)).toEqual(['e1', 'boot']);
	});
});

describe('clear-all (spec §6)', () => {
	it('wipes interpretations too (round-2 coverage hole)', async () => {
		await saveInterpretation('evt1', 'm', 'card', { title: 'C' });
		await clearAllLocalData();
		expect(await getInterpretation('evt1', 'm')).toBeNull();
	});
	it('clears all stores while another connection holds the DB open (review H-4)', async () => {
		await saveSettings({ model: 'm1' });
		const other = await openDB(DB_NAME, DB_VERSION);
		try {
			await clearAllLocalData(); // store-clearing, not deleteDB, so nothing blocks
			expect(isPersistent()).toBe(true);
			expect(await loadSettings()).toBeNull();
		} finally {
			other.close();
		}
	});
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

describe('schema upgrade (v1 → v2 convergence)', () => {
	const LEGACY_SETTINGS: PersistedSettings = {
		model: 'm1',
		endpoint: 'https://a/v1',
		relays: [],
		appearance: 'dark'
	};

	/** Drops whatever the shared beforeEach created, then stands up a legacy
	 * DB with the given stores. fake-indexeddb persists DBs by name within
	 * a file run, so the old database must be deleted first — opening a
	 * *lower* version against an existing higher-version DB just reopens the
	 * higher one, which is exactly the downgrade scenario under test.
	 * `version` defaults to 1 for the original v1 convergence cases; a higher
	 * seed simulates a newer live schema that is still missing a backfill
	 * (what the v4 bump re-opens in the test below). */
	async function seedLegacy(
		upgrade: (db: IDBPDatabase) => void,
		seed?: (db: IDBPDatabase) => Promise<void>,
		version = 1
	) {
		_closeForTests();
		await deleteDB(DB_NAME);
		const legacy = await openDB(DB_NAME, version, { upgrade });
		await seed?.(legacy);
		legacy.close();
		await initPersistence();
	}

	it('converges a partial foreign schema onto the four-store set (issue #12 deferred upgrade)', async () => {
		// An older checkout's DB that never matched our store layout: only a
		// 'legacy' store, none of the four we actually use. Pre-fix this makes
		// every transaction NotFoundError, so the layer silently degrades to
		// memory-only and the round-trip below returns null.
		await seedLegacy((db) => db.createObjectStore('legacy', { keyPath: 'id' }));
		await saveSettings({ ...LEGACY_SETTINGS });
		expect(await loadSettings()).toEqual({ ...LEGACY_SETTINGS });
		// Foreign stores from the older checkout are left in place — the layer
		// only reads its own four — so assert presence, not an exact store set.
		const dump = await dumpAllForTests();
		for (const store of ['deadLetters', 'interpretations', 'sessions', 'settings']) {
			expect(dump[store]).toBeDefined();
		}
	});

	it('preserves a settings record across a healthy v1 → v2 upgrade', async () => {
		await seedLegacy(
			(db) => {
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
				sessions.createIndex('createdAt', 'createdAt');
				db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
			},
			async (db) => {
				await db.put('settings', { key: 'app', value: { model: 'm1' } });
			}
		);
		// The convergence upgrade must not drop data that already exists.
		expect(await loadSettings()).toEqual({ model: 'm1' });
		await clearAllLocalData();
		expect(await loadSettings()).toBeNull();
		expect(isPersistent()).toBe(true);
	});

	it('adds the createdAt index to a sessions store that lacks it', async () => {
		// sessions exists but an older checkout never created its 'createdAt'
		// index (the sidebar's newest-first order, issue #10) — listSessions would otherwise
		// NotFoundError on getAllFromIndex and degrade to [].
		await seedLegacy(
			(db) => {
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				db.createObjectStore('sessions', { keyPath: 'id' });
				db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
			},
			async (db) => {
				await db.put('sessions', { id: 's1', title: 'one', createdAt: 100 });
			}
		);
		expect(await listSessions()).toEqual([{ id: 's1', title: 'one', createdAt: 100 }]);
		expect(isPersistent()).toBe(true);
	});

	it('backfills the events indexes onto a stale v3 store so listEvents works (issue #27, v4 bump)', async () => {
		// A live v3 database whose events store never got its indexes — the
		// cache row landed with the store, the index backfills followed in a
		// later checkout. Reopening at DB_VERSION before the v4 bump was 3 == 3,
		// so NO upgrade fired, the guards never ran, and listEvents
		// NotFoundError'd on the missing created_at index and silently degraded
		// to [] — the owner's "[db] op failed … index was not found" with cards
		// showing raw events (the search seam hydrates from listEvents at boot).
		// The v4 bump forces the upgrade for any live db at ≤ 3, which runs the
		// guards and backfills both indexes.
		await seedLegacy(
			(db) => {
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
				sessions.createIndex('createdAt', 'createdAt');
				db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
				db.createObjectStore('events', { keyPath: 'id' }); // stale: no ttags / created_at yet
			},
			async (db) => {
				await db.put('events', {
					id: 'e1',
					sig: 'ab'.repeat(64),
					pubkey: 'cd'.repeat(32),
					created_at: 1000,
					kind: 1,
					tags: [['t', 'nostr']],
					content: 'one',
					ttags: ['nostr'] // the denormalized field the multiEntry index keys on
				});
			},
			3
		);
		expect(isPersistent()).toBe(true);
		// Pre-fix this logged the owner's NotFoundError and returned [].
		expect((await listEvents()).map((e) => e.id)).toEqual(['e1']);
		expect(await getEventsByTag('nostr')).toEqual(['e1']);
	});
});
