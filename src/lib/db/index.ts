/**
 * IndexedDB persistence layer (spec §6; issue #12).
 * Row store: `idb` — chosen over Dexie/raw/SQLite in the decision thread on
 * issue #12. Search is NOT part of this layer: the events cache + FlexSearch
 * engine ride on top of it in a later issue (spec §11 step 2).
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

export const DB_NAME = 'scrutiny-lens';
const DB_VERSION = 1;
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

interface LensDB extends DBSchema {
	settings: { key: string; value: { key: string; value: Partial<PersistedSettings> } };
	interpretations: { key: [string, string]; value: PersistedInterpretation };
	sessions: { key: string; value: PersistedSession; indexes: { createdAt: number } };
	deadLetters: { key: number; value: DeadLetterEntry };
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
			upgrade(db) {
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('interpretations', { keyPath: ['eventId', 'model'] });
				const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
				sessions.createIndex('createdAt', 'createdAt');
				db.createObjectStore('deadLetters', { keyPath: 'id', autoIncrement: true });
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
 * the memory-only contract instead of rejecting at the call site. */
async function attempt<T>(op: (d: IDBPDatabase<LensDB>) => Promise<T>, fallback: T): Promise<T> {
	try {
		const d = await db();
		return d ? await op(d) : fallback;
	} catch {
		return fallback;
	}
}

export async function saveSettings(patch: Partial<PersistedSettings>): Promise<void> {
	await attempt(async (d) => {
		const existing = (await d.get('settings', SETTINGS_KEY))?.value ?? {};
		await d.put('settings', { key: SETTINGS_KEY, value: normalize({ ...existing, ...patch }) });
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

/** Appends and trims to the newest DEAD_LETTER_CAP inside one transaction
 * (ring semantics from issue #12). Callers treat this as fire-and-forget. */
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

/** "Clear all local data" (spec §6). Records are cleared through our own
 * connection in one transaction — NOT via deleteDB: a delete blocked by
 * another tab's open connection pends forever AND wedges every later open
 * behind it, hanging the whole layer (review H-4, reproduced in tests).
 * Clearing records has no versionchange step, so it can never block.
 * The settings button (#11) additionally reloads the page for a full
 * in-memory wipe. */
export async function clearAllLocalData(): Promise<void> {
	await attempt(async (d) => {
		const names = ['settings', 'interpretations', 'sessions', 'deadLetters'] as const;
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
