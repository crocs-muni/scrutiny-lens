import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_DB_PATH = './data/scrutiny.db';

let db: DatabaseSync | null = null;

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
	mkdirSync(dirname(dbPath), { recursive: true });
	const database = new DatabaseSync(dbPath);
	database.exec('PRAGMA journal_mode = WAL');
	database.exec(`
		CREATE TABLE IF NOT EXISTS vm_cache (
			entityType TEXT,
			entityId TEXT,
			schemaVersion TEXT,
			profile TEXT,
			model TEXT,
			vmJson TEXT,
			createdAt INTEGER,
			PRIMARY KEY(entityType, entityId, schemaVersion, profile, model)
		);
		CREATE TABLE IF NOT EXISTS dead_letter (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entityType TEXT,
			entityId TEXT,
			schemaVersion TEXT,
			profile TEXT,
			model TEXT,
			payload TEXT,
			reason TEXT,
			createdAt INTEGER
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			query TEXT,
			rootEventId TEXT,
			graphJson TEXT,
			chatJson TEXT,
			expandedJson TEXT,
			hopDepth INTEGER,
			lastSyncedAt INTEGER,
			createdAt INTEGER,
			updatedAt INTEGER
		);
	`);
	return database;
}

export function getDb(): DatabaseSync {
	return (db ??= openDb());
}
