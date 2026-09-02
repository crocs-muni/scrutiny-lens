// Events cache (issue #27, spec §6/§11 step 2): the idb events store on the
// v3 schema — PK `id`, multiEntry index over t-tag values, `created_at`
// index — plus the no-cap write path (QuotaExceededError skips silently per
// the #12 ruling).

import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	DB_NAME,
	_closeForTests,
	cacheEvent,
	clearAllLocalData,
	dumpAllForTests,
	getEvent,
	getEventsByTag,
	initPersistence,
	isPersistent,
	listEvents,
	loadSettings
} from '$lib/db';
import type { NostrEvent } from '$lib/fabric';

function event(id: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
	return {
		id,
		sig: 'ab'.repeat(64),
		pubkey: 'cd'.repeat(32),
		created_at: 1000,
		kind: 1,
		tags: [
			['t', 'scrutiny-product'],
			['t', 'cve-2017-15361']
		],
		content: `content of ${id}`,
		...overrides
	};
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

afterEach(() => {
	_closeForTests();
});

describe('events store (spec §6)', () => {
	it('caches and reads back an event by id', async () => {
		await cacheEvent(event('e1'));
		expect(await getEvent('e1')).toEqual({ ...event('e1'), ttags: ['scrutiny-product', 'cve-2017-15361'] });
	});

	it('upserts: caching the same id twice replaces the row', async () => {
		await cacheEvent(event('e1'));
		await cacheEvent(event('e1', { content: 'updated' }));
		expect((await getEvent('e1'))?.content).toBe('updated');
		expect((await listEvents()).length).toBe(1);
	});

	it('indexes events by t-tag value (multiEntry)', async () => {
		await cacheEvent(event('e1'));
		await cacheEvent(event('e2', { tags: [['t', 'scrutiny-metadata']] }));
		expect(await getEventsByTag('cve-2017-15361')).toEqual(['e1']);
		expect(await getEventsByTag('scrutiny-metadata')).toEqual(['e2']);
		expect(await getEventsByTag('scrutiny-product')).toEqual(['e1']);
		expect(await getEventsByTag('no-such-tag')).toEqual([]);
	});

	it('keeps a created_at index for chronological reads (newest last ascending)', async () => {
		await cacheEvent(event('e1', { created_at: 3000 }));
		await cacheEvent(event('e2', { created_at: 1000 }));
		await cacheEvent(event('e3', { created_at: 2000 }));
		expect((await listEvents()).map((e) => e.id)).toEqual(['e2', 'e3', 'e1']);
	});

	it('caches an event with no t-tags without tripping the index', async () => {
		await cacheEvent(event('e1', { tags: [] }));
		expect(await getEvent('e1')).toBeDefined();
		expect(await getEventsByTag('cve-2017-15361')).toEqual([]);
	});

	it('clear-all covers the events store', async () => {
		await cacheEvent(event('e1'));
		await clearAllLocalData();
		expect(await getEvent('e1')).toBeNull();
		expect(await listEvents()).toEqual([]);
	});
});

describe('schema upgrade (v2 → v3: events store, issue #27)', () => {
	it('healthy v2 rows survive the bump and the events store appears', async () => {
		// Seed a v2 clone of the shipped schema with data (kept record + row),
		// then re-open through the layer.
		_closeForTests();
		await deleteDB(DB_NAME);
		const legacy = await openDB(DB_NAME, 2, {
			upgrade(db) {
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
				sessions.createIndex('createdAt', 'createdAt');
				db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
			}
		});
		await legacy.put('settings', { key: 'app', value: { model: 'm1' } });
		legacy.close();
		await initPersistence();

		expect(await dumpAllForTests()).toHaveProperty('events');
		expect(await loadSettings()).toEqual({ model: 'm1' });
		await cacheEvent(event('e1'));
		expect(await getEvent('e1')).toEqual({ ...event('e1'), ttags: ['scrutiny-product', 'cve-2017-15361'] });
		await clearAllLocalData();
		expect(await getEvent('e1')).toBeNull();
		expect(isPersistent()).toBe(true);
	});
});
