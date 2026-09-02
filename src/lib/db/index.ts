/**
 * IndexedDB persistence layer (spec §6; issue #12).
 * Row store: `idb` — chosen over Dexie/raw/SQLite in the decision thread on
 * issue #12. Search is NOT part of this layer: the events cache (issue #27)
 * is rows only — the FlexSearch engine rides on top via the $lib/search
 * seam (spec §11 step 2).
 *
 * Contract (spec §6):
 *  - Unencrypted by design; anything on this device/profile can read it.
 *  - The API key is memory-only: absent from persisted types, and stripped
 *    from every write path via registerSecret().
 *  - storage.persist() is requested opportunistically at init and its result
 *    is never acted on (Safari 17+ exempts persisted origins from the 7-day
 *    ITP purge, so the one ask is worth it).
 *  - Silent degrade: ANY IDB failure — unavailable at open, or a
 *    quota/private-mode abort mid-flight — turns writes into no-ops and
 *    loads into empty results. Callers never see a rejection (attempt()).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DeadLetterEntry } from '$lib/ai/deadLetter';
import type { NostrEvent } from '$lib/fabric';

export const DB_NAME = 'scrutiny-lens';
export const DB_VERSION = 3;
const SETTINGS_KEY = 'app';

/** Ring size for the dead-letter store; deadLetter.ts imports this so the
 * in-memory mirror and the persisted ring never disagree. */
export const DEAD_LETTER_CAP = 200;

/** Persisted half of settings (spec §5/§6: endpoint, model, relays,
 * appearance). The API key is intentionally not representable here. */
export interface PersistedSettings {
	endpoint: string;
	model: string;
	relays: string[];
	appearance: 'light' | 'dark' | 'system';
}

/** One AI-written interpretation under [eventId, model]. One event yields two
 * artifacts (search card, graph node), so bySurface keeps them from colliding
 * on the issue-specified key. */
export interface PersistedInterpretation {
	eventId: string;
	model: string;
	bySurface: Record<string, unknown>;
	at: number;
}

/** Mirrors shell's SessionRow field-for-field — keep it in lockstep with
 * src/lib/shell.svelte.ts (the db module deliberately never imports runes). */
export interface PersistedSession {
	id: string;
	title: string;
	createdAt: number;
	unseen?: boolean;
}
/** Derives the t-tag values indexed under `ttags` — one derivation, shared
 * by the db write path and the search seam so the engine and the index can
 * never disagree on what was indexed. */
export function tTagsOf(event: NostrEvent): string[] {
	return event.tags.filter((t) => t[0] === 't' && t[1] !== undefined).map((t) => t[1]);
}

/** Cached fetched event (issue #27, spec §11 step 2). `ttags` is the derived
 * list of t-tag VALUES the multiEntry index keys on — IDB has no nested-
 * array keyPath, so the derivation denormalizes on write. No ring cap (the
 * #12 ruling): writes ride the same attempt() degrade contract, so a
 * QuotaExceededError skips the write and the app moves on. */
export interface CachedEvent extends NostrEvent {
	ttags: string[];
}

interface LensDB extends DBSchema {
	settings: { key: string; value: { key: string; value: Partial<PersistedSettings> } };
	interpretations: { key: [string, string]; value: PersistedInterpretation };
	sessions: { key: string; value: PersistedSession; indexes: { createdAt: number } };
	deadLetters: { key: number; value: DeadLetterEntry };
	events: {
		key: string;
		value: CachedEvent;
		indexes: { ttags: string; created_at: number };
	};
}

let conn: IDBPDatabase<LensDB> | undefined;
let ready: Promise<void> | null = null;
let persistent = false;

const secrets = new Set<string>();

/** Shorter secrets would redact innocent substrings out of unrelated
 * payloads (review M-5). Real API keys are far longer. */
const MIN_SECRET_LENGTH = 8;

/** Registers a value (the API key) that must never reach any stored object
 * (spec §6). The settings flow (#11) calls this when the user sets the key —
 * the strip is inert until then. */
export function registerSecret(secret: string): void {
	if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
}

// Every stored object passes one JSON round-trip so its shape never depends
// on registration state (review M-6). Secrets are redacted in BOTH encodings:
// raw, and JSON-escaped — a secret containing `"`/`\`/newline never appears
// raw inside stringified JSON and would otherwise slip through (review H-2).
function normalize<T>(value: T): T {
	if (value === undefined) return value;
	let text = JSON.stringify(value);
	if (text === undefined) return value; // functions and other non-JSON values
	for (const secret of secrets) {
		const escaped = JSON.stringify(secret).slice(1, -1);
		if (escaped !== secret) text = text.replaceAll(escaped, '');
		text = text.replaceAll(secret, '');
	}
	return JSON.parse(text) as T;
}

export function isPersistent(): boolean {
	return persistent;
}

export async function initPersistence(): Promise<void> {
	ready ??= open();
	await ready;
}

async function open(): Promise<void> {
	try {
		if (typeof indexedDB === 'undefined') return; // node without shim, very old private modes
		conn = await openDB<LensDB>(DB_NAME, DB_VERSION, {
			upgrade(db, _oldVersion, _newVersion, transaction) {
				// Converge any pre-existing (v1) database onto the full schema
				// instead of assuming a fresh create. createObjectStore inside
				// an upgrade throws NotFoundError if the store already exists,
				// so a browser holding a v1 'scrutiny-lens' DB from an older
				// checkout would otherwise fail the whole upgrade and silently
				// degrade to memory-only — the deferred schema-upgrade test
				// promised on issue #12 (see that thread). Guard every create.
				if (!db.objectStoreNames.contains('settings')) {
					db.createObjectStore('settings', { keyPath: 'key' });
				}
				if (!db.objectStoreNames.contains('interpretations')) {
					db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				}
				if (!db.objectStoreNames.contains('sessions')) {
					const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
					sessions.createIndex('createdAt', 'createdAt');
				} else if (!transaction.objectStore('sessions').indexNames.contains('createdAt')) {
					// An older checkout's sessions store may predate the
					// createdAt index (the sidebar's newest-first order, issue #10); add it
					// from the upgrade transaction. Existing stores are only reachable via the
					// versionchange transaction's objectStore() — createIndex on an
					// already-complete row layout would throw ConstraintError, so
					// the contains() guard both avoids that and stays a no-op.
					transaction.objectStore('sessions').createIndex('createdAt', 'createdAt');
				}
				if (!db.objectStoreNames.contains('deadLetters')) {
					db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
				}
				if (!db.objectStoreNames.contains('events')) {
					// v3 (issue #27): the local events cache. Both indexes are
					// cheap to rebuild — the cache is re-populated from relays.
					const events = db.createObjectStore('events', { keyPath: 'id' });
					events.createIndex('ttags', 'ttags', { multiEntry: true });
					events.createIndex('created_at', 'created_at');
				} else {
					// Foreign older schemas may hold an 'events' store with no
					// (or stale) indexes — degrade would otherwise silently eat
					// tag and chronological reads forever (same hole class as
					// the sessions createdAt backfill above).
					const events = transaction.objectStore('events');
					if (!events.indexNames.contains('ttags')) {
						events.createIndex('ttags', 'ttags', { multiEntry: true });
					}
					if (!events.indexNames.contains('created_at')) {
						events.createIndex('created_at', 'created_at');
					}
				}
			}
		});
		persistent = true;
		void navigator.storage?.persist?.().catch(() => {});
	} catch {
		// Safari private windows can open IDB yet abort transactions; any open
		// failure simply means memory-only operation (spec §6 silent degrade).
		conn = undefined;
	}
}

/** Waits for init only once it has started; without init the module stays
 * memory-only and every API silently no-ops. */
async function db(): Promise<IDBPDatabase<LensDB> | undefined> {
	if (!ready) return undefined;
	await ready;
	return conn;
}

/** Single failure semantics for the whole layer (spec §6, review H-1): any
 * request-level IDB error — quota, abort, a closed connection — degrades to
 * the memory-only contract instead of rejecting at the call site. The user
 * never sees it; the developer hears about it (review T-5: a typo'd store
 * name would otherwise die silently behind a green suite). */
async function attempt<T>(op: (d: IDBPDatabase<LensDB>) => Promise<T>, fallback: T): Promise<T> {
	try {
		const d = await db();
		return d ? await op(d) : fallback;
	} catch (err) {
		console.warn('[db] op failed, degrading to memory-only fallback —', err);
		return fallback;
	}
}

/** One transaction like saveInterpretation (review T-1): the settings flow
 * fires concurrent patches (endpoint save racing appearance toggle), and
 * two auto-commit transactions would lose one. */
export async function saveSettings(patch: Partial<PersistedSettings>): Promise<void> {
	await attempt(async (d) => {
		const tx = d.transaction('settings', 'readwrite');
		const existing = (await tx.store.get(SETTINGS_KEY))?.value ?? {};
		await tx.store.put({
			key: SETTINGS_KEY,
			value: normalize({ ...existing, ...patch })
		});
		await tx.done;
	}, undefined);
}

/** Partial by design: fields accumulate via saveSettings patches until the
 * settings flow (#11) has saved them all. */
export async function loadSettings(): Promise<Partial<PersistedSettings> | null> {
	return attempt(async (d) => (await d.get('settings', SETTINGS_KEY))?.value ?? null, null);
}

/** Merge-on-write: a later surface on the same [eventId, model] adds to
 * bySurface instead of overwriting the other artifact. One transaction — two
 * overlapping calls (the card+node pair of one event) must merge, not race
 * into a lost surface (review H-3). */
export async function saveInterpretation(
	eventId: string,
	model: string,
	surface: string,
	value: unknown
): Promise<void> {
	await attempt(async (d) => {
		const tx = d.transaction('interpretations', 'readwrite');
		const existing = await tx.store.get([eventId, model]);
		await tx.store.put(
			normalize<PersistedInterpretation>({
				eventId,
				model,
				bySurface: { ...(existing?.bySurface ?? {}), [surface]: value },
				at: Date.now()
			})
		);
		await tx.done;
	}, undefined);
}

export async function getInterpretation(
	eventId: string,
	model: string
): Promise<PersistedInterpretation | null> {
	return attempt(async (d) => (await d.get('interpretations', [eventId, model])) ?? null, null);
}

export async function putSession(row: PersistedSession): Promise<void> {
	await attempt(async (d) => {
		await d.put('sessions', normalize(row));
	}, undefined);
}

export async function deleteSession(id: string): Promise<void> {
	await attempt(async (d) => {
		await d.delete('sessions', id);
	}, undefined);
}

/** Newest first — the sidebar rail's display order (SidebarRecents anatomy). */
export async function listSessions(): Promise<PersistedSession[]> {
	return attempt(async (d) => (await d.getAllFromIndex('sessions', 'createdAt')).reverse(), []);
}

/** Appends and trims inside one transaction, keeping the DEAD_LETTER_CAP
 * most recently APPENDED entries (cursor order = insertion order; identical
 * to newest-by-`at` in real flow since `at` is stamped at write time —
 * review T-4). Callers treat this as fire-and-forget. */
export async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
	await attempt(async (d) => {
		const tx = d.transaction('deadLetters', 'readwrite');
		await tx.store.add(normalize(entry));
		const count = await tx.store.count();
		if (count > DEAD_LETTER_CAP) {
			let toDelete = count - DEAD_LETTER_CAP;
			for (let cursor = await tx.store.openCursor(); cursor && toDelete > 0; toDelete--) {
				await cursor.delete();
				cursor = await cursor.continue();
			}
		}
		await tx.done;
	}, undefined);
}

export async function loadDeadLetters(): Promise<DeadLetterEntry[]> {
	return attempt(async (d) => await d.getAll('deadLetters'), []);
}

/** Caches a fetched event (issue #27). Immutability means upsert-by-id; the
 * derived ttags array feeds the multiEntry index. As everywhere in this
 * layer, a write failure — quota exceeded included — degrades silently
 * (spec §6): the event is simply not cached. Returns the redacted row as
 * stored (never the raw event), or null on a skipped write — the search
 * seam needs both to index exactly what the cache holds. */
export async function cacheEvent(event: NostrEvent): Promise<CachedEvent | null> {
	const row: CachedEvent = {
		...event,
		ttags: tTagsOf(event)
	};
	return attempt(async (d) => {
		const normalized = normalize(row);
		await d.put('events', normalized);
		return normalized;
	}, null);
}

export async function getEvent(id: string): Promise<CachedEvent | null> {
	return attempt(async (d) => (await d.get('events', id)) ?? null, null);
}

/** Event ids carrying a t-tag value — deterministic tag lookup stays out of
 * the search engine by spec §3 ("post-filters on the result set"). */
export async function getEventsByTag(value: string): Promise<string[]> {
	return attempt(
		async (d) => (await d.getAllKeysFromIndex('events', 'ttags', value)).map(String),
		[]
	);
}

/** Every cached event oldest-first (created_at index) — the search seam
 * hydrates its engine from this list at boot (issue #27). */
export async function listEvents(): Promise<CachedEvent[]> {
	return attempt(async (d) => await d.getAllFromIndex('events', 'created_at'), []);
}

/** "Clear all local data" (spec §6). Records are cleared through our own
 * connection in one transaction — NOT via deleteDB: a delete blocked by
 * another tab's open connection pends forever AND wedges every later open
 * behind it, hanging the whole layer (review H-4, reproduced in tests).
 * Clearing records has no versionchange step, so it can never block.
 * The settings button (#11) additionally reloads the page for a full
 * in-memory wipe. */
export async function clearAllLocalData(): Promise<void> {
	await attempt(async (d) => {
		// Store list comes from the live schema, not a constant: a later
		// schema's store (the v3 events store landed this way) can never be
		// silently skipped by clear-all. Materialize to a plain array first:
		// fake-indexeddb rejects its own objectStoreNames object as the
		// transaction scope (browsers accept it).
		const names = Array.from(d.objectStoreNames);
		const tx = d.transaction(names, 'readwrite');
		await Promise.all(names.map((n) => tx.objectStore(n).clear()));
		await tx.done;
	}, undefined);
}

/** Test seams — not for app code. */

/** Simulates a reload: closes the connection but keeps the stored data. */
export function _closeForTests(): void {
	conn?.close();
	conn = undefined;
	persistent = false;
	ready = null;
}

export async function dumpAllForTests(): Promise<Record<string, unknown[]>> {
	return attempt(async (d) => {
		const out: Record<string, unknown[]> = {};
		for (const name of Array.from(d.objectStoreNames)) out[name] = await d.getAll(name);
		return out;
	}, {});
}
