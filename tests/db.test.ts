import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '$lib/server/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'scrutiny-db-'));
	db = openDb(join(dir, 'scrutiny.db'));
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('db', () => {
	it('creates vm_cache, dead_letter, and sessions tables', () => {
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name")
			.all() as { name: string }[];
		expect(rows.map((r) => r.name)).toEqual(['dead_letter', 'sessions', 'vm_cache']);
	});

	it('inserts, replaces, and reads vm_cache rows by composite key', () => {
		const upsert = db.prepare(`
			INSERT INTO vm_cache (entityType, entityId, schemaVersion, profile, model, vmJson, createdAt)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(entityType, entityId, schemaVersion, profile, model)
			DO UPDATE SET vmJson = excluded.vmJson, createdAt = excluded.createdAt
		`);
		upsert.run('product', 'p1', 'v1', 'default', 'coder', '{"a":1}', 1000);
		upsert.run('product', 'p1', 'v1', 'default', 'coder', '{"a":2}', 2000);

		const row = db
			.prepare('SELECT vmJson, createdAt FROM vm_cache WHERE entityType = ? AND entityId = ?')
			.get('product', 'p1') as { vmJson: string; createdAt: number };

		expect(row.vmJson).toBe('{"a":2}');
		expect(row.createdAt).toBe(2000);

		const count = db.prepare('SELECT COUNT(*) AS n FROM vm_cache').get() as { n: number };
		expect(count.n).toBe(1);
	});

	it('autoincrements dead_letter ids', () => {
		const ins = db.prepare(`
			INSERT INTO dead_letter (entityType, entityId, schemaVersion, profile, model, payload, reason, createdAt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const r1 = ins.run('product', 'p1', 'v1', 'default', 'coder', '{}', 'boom', 1);
		const r2 = ins.run('product', 'p2', 'v1', 'default', 'coder', '{}', 'boom', 2);

		expect(Number(r2.lastInsertRowid)).toBe(Number(r1.lastInsertRowid) + 1);

		const rows = db.prepare('SELECT id FROM dead_letter ORDER BY id').all() as { id: number }[];
		expect(rows.map((r) => r.id)).toEqual([
			Number(r1.lastInsertRowid),
			Number(r2.lastInsertRowid)
		]);
	});
});
