import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { readModel, writeModel, writeDeadLetter, setCacheDb } from '$lib/server/ai/cache';
import { openDb } from '$lib/server/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const vmSchema = z.object({ title: z.string(), count: z.number() });

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'scrutiny-cache-'));
	db = openDb(join(dir, 'scrutiny.db'));
	setCacheDb(db);
});

afterEach(() => {
	setCacheDb(null);
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('cache read/write', () => {
	it('round-trips a value under the composite key', () => {
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'Infineon', count: 3 });
		const got = readModel('product', 'p1', 'v1', 'default', 'coder', vmSchema);
		expect(got).toEqual({ title: 'Infineon', count: 3 });
	});

	it('upserts in place (replacing) for the same composite key', () => {
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'a', count: 1 });
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'b', count: 2 });
		const got = readModel('product', 'p1', 'v1', 'default', 'coder', vmSchema);
		expect(got).toEqual({ title: 'b', count: 2 });
		const rows = db.prepare('SELECT COUNT(*) AS n FROM vm_cache').get() as { n: number };
		expect(rows.n).toBe(1);
	});

	it('returns null for a different schemaVersion (cache miss)', () => {
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'a', count: 1 });
		expect(readModel('product', 'p1', 'v2', 'default', 'coder', vmSchema)).toBeNull();
	});

	it('returns null for a different entity or profile', () => {
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'a', count: 1 });
		expect(readModel('product', 'p2', 'v1', 'default', 'coder', vmSchema)).toBeNull();
		expect(readModel('product', 'p1', 'v1', 'other', 'coder', vmSchema)).toBeNull();
	});

	it('rejects (gaps) a stored value that fails the schema on read', () => {
		writeModel('product', 'p1', 'v1', 'default', 'coder', { title: 'a', count: 'not-a-number' });
		expect(readModel('product', 'p1', 'v1', 'default', 'coder', vmSchema)).toBeNull();
	});

	it('rejects unparseable stored JSON on read', () => {
		db.prepare(
			`INSERT INTO vm_cache (entityType, entityId, schemaVersion, profile, model, vmJson, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('product', 'p1', 'v1', 'default', 'coder', 'not-json', 1);
		expect(readModel('product', 'p1', 'v1', 'default', 'coder', vmSchema)).toBeNull();
	});
});

describe('dead_letter', () => {
	it('records the payload and reason', () => {
		writeDeadLetter('product', 'p1', 'v1', 'default', 'coder', { title: 'x' }, 'invented reason');
		const row = db
			.prepare('SELECT entityType, entityId, payload, reason FROM dead_letter')
			.get() as { entityType: string; entityId: string; payload: string; reason: string };
		expect(row.entityType).toBe('product');
		expect(row.entityId).toBe('p1');
		expect(JSON.parse(row.payload)).toEqual({ title: 'x' });
		expect(row.reason).toBe('invented reason');
	});
});
