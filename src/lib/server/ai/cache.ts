/**
 * W3 · AI pipeline core — VM cache + dead-letter store.
 * Prepared statements over getDb() (src/lib/server/db.ts).
 *
 * vm_cache key = `${entityType}:${entityId}:${schemaVersion}:${profile}:${model}`
 * (composite PK already defined in db.ts). Cache reads are validate-on-read:
 * a stored value that fails the caller's schema is a cache gap and is treated
 * as a miss (null), never returned stale or corrupt.
 */

	import { z } from 'zod';
	import type { DatabaseSync } from 'node:sqlite';
	import { getDb } from '../db';

/**
 * Test seam: point cache helpers at an isolated DatabaseSync (a temp file).
 * Null restores the production getDb() singleton.
 */
let overrideDb: DatabaseSync | null = null;
export function setCacheDb(db: DatabaseSync | null): void {
	overrideDb = db;
}

function db(): DatabaseSync {
	return overrideDb ?? getDb();
}

export interface CacheKey {
	entityType: string;
	entityId: string;
	schemaVersion: string;
	profile: string;
	model: string;
}

const KEY_COLS = 'entityType, entityId, schemaVersion, profile, model';

/**
 * Validate-on-read cache hit. Returns T when a row exists AND its stored JSON
 * passes `schema`; otherwise null (treated as a miss).
 */
export function readModel<T>(
	entityType: string,
	entityId: string,
	schemaVersion: string,
	profile: string,
	model: string,
	schema: z.ZodType<T>
): T | null {
	const row = db()
		.prepare(
			'SELECT vmJson FROM vm_cache WHERE entityType = ? AND entityId = ? AND schemaVersion = ? AND profile = ? AND model = ?'
		)
		.get(entityType, entityId, schemaVersion, profile, model) as { vmJson: string } | undefined;
	if (!row) return null;
	try {
		const parsed = schema.safeParse(JSON.parse(row.vmJson));
		if (!parsed.success) return null; // zod-on-read gap → reject
		return parsed.data;
	} catch {
		return null;
	}
}

/** Upsert a VM into the cache under the composite key. */
export function writeModel(
	entityType: string,
	entityId: string,
	schemaVersion: string,
	profile: string,
	model: string,
	value: unknown
): void {
	db()
		.prepare(
			`INSERT INTO vm_cache (${KEY_COLS}, vmJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(${KEY_COLS}) DO UPDATE SET vmJson = excluded.vmJson, createdAt = excluded.createdAt`
		)
		.run(entityType, entityId, schemaVersion, profile, model, JSON.stringify(value), Date.now());
}

/** Record a rejected-but-interesting candidate to the dead_letter table. */
export function writeDeadLetter(
	entityType: string,
	entityId: string,
	schemaVersion: string,
	profile: string,
	model: string,
	payload: unknown,
	reason: string
): void {
	db()
		.prepare(
			`INSERT INTO dead_letter (${KEY_COLS}, payload, reason, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			entityType,
			entityId,
			schemaVersion,
			profile,
			model,
			JSON.stringify(payload),
			reason,
			Date.now()
		);
}
