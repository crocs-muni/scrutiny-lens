import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface CacheEnv {
	AI_CACHE_PATH?: string;
}

let db: Database.Database | null = null;

function getDb(env: CacheEnv): Database.Database {
	if (!db) {
		const path = env.AI_CACHE_PATH ?? './data/ai-cache.sqlite';
		db = new Database(path);
		db.exec(`
			CREATE TABLE IF NOT EXISTS ai_cache (
				key TEXT PRIMARY KEY,
				agent TEXT NOT NULL,
				value TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_agent ON ai_cache(agent);
		`);
	}
	return db;
}

export function cacheKey(agent: string, input: unknown): string {
	const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
	return `${agent}:${hash}`;
}

export function getCache(env: CacheEnv, agent: string, input: unknown): unknown | null {
	const key = cacheKey(agent, input);
	const row = getDb(env)
		.prepare('SELECT value FROM ai_cache WHERE key = ?')
		.get(key) as { value: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.value);
	} catch {
		return null;
	}
}

export function setCache(
	env: CacheEnv,
	agent: string,
	input: unknown,
	value: unknown,
	model: string
): void {
	const key = cacheKey(agent, input);
	getDb(env)
		.prepare(
			'INSERT OR REPLACE INTO ai_cache (key, agent, value, model, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.run(key, agent, JSON.stringify(value), model, Date.now());
}

export function clearCache(env: CacheEnv, agent?: string): void {
	if (agent) {
		getDb(env).prepare('DELETE FROM ai_cache WHERE agent = ?').run(agent);
	} else {
		getDb(env).prepare('DELETE FROM ai_cache').run();
	}
}
