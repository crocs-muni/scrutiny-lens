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
 *  - Silent degrade: when IDB is unavailable or aborts (private windows),
 *    writes become no-ops and loads return empty. Callers never see it.
 */
import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import type { DeadLetterEntry } from '$lib/ai/deadLetter';

export const DB_NAME = 'scrutiny-lens';
const DB_VERSION = 1;
const SETTINGS_KEY = 'app';
const DEAD_LETTER_CAP = 200;

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

/** Mirrors shell's SessionRow; kept as its own type so this module never
 * imports the runes module. */
export interface PersistedSession {
	id: string;
	title: string;
	createdAt: number;
	unseen?: boolean;
}

let conn: IDBPDatabase | undefined;
let ready: Promise<void> | null = null;
let persistent = false;

const secrets = new Set<string>();

/** Registers a value (the API key) that must never reach any stored object
 * (spec §6). The settings flow (#11) calls this when the user sets the key. */
export function registerSecret(secret: string): void {
	if (secret) secrets.add(secret);
}

// Applied to every write regardless of which caller built the payload: JSON
// round-trip strips registered secrets from nested values (and key names) in
// one pass, and also normalizes anything non-structured-cloneable away.
function stripSecrets<T>(value: T): T {
	if (secrets.size === 0) return value;
	let text = JSON.stringify(value);
	for (const secret of secrets) text = text.replaceAll(secret, '');
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
		conn = await openDB(DB_NAME, DB_VERSION, {
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
async function db(): Promise<IDBPDatabase | undefined> {
	if (!ready) return undefined;
	await ready;
	return conn;
}

export async function saveSettings(patch: Partial<PersistedSettings>): Promise<void> {
	const d = await db();
	if (!d) return;
	const existing = ((await d.get('settings', SETTINGS_KEY))?.value ?? {}) as Partial<PersistedSettings>;
	const value = stripSecrets({ ...existing, ...patch });
	await d.put('settings', { key: SETTINGS_KEY, value });
}

export async function loadSettings(): Promise<PersistedSettings | null> {
	const d = await db();
	const row = await d?.get('settings', SETTINGS_KEY);
	return (row?.value as PersistedSettings | undefined) ?? null;
}

/** Merge-on-write: a later surface on the same [eventId, model] adds to
 * bySurface instead of overwriting the other artifact. */
export async function saveInterpretation(
	eventId: string,
	model: string,
	surface: string,
	value: unknown
): Promise<void> {
	const d = await db();
	if (!d) return;
	const existing = (await d.get('interpretations', [eventId, model])) as
		| PersistedInterpretation
		| undefined;
	const rec: PersistedInterpretation = {
		eventId,
		model,
		bySurface: { ...(existing?.bySurface ?? {}), [surface]: stripSecrets(value) },
		at: Date.now()
	};
	await d.put('interpretations', rec);
}

export async function getInterpretation(
	eventId: string,
	model: string
): Promise<PersistedInterpretation | null> {
	const d = await db();
	return ((await d?.get('interpretations', [eventId, model])) as
		| PersistedInterpretation
		| undefined) ?? null;
}

export async function putSession(row: PersistedSession): Promise<void> {
	const d = await db();
	if (!d) return;
	await d.put('sessions', stripSecrets(row));
}

export async function deleteSession(id: string): Promise<void> {
	const d = await db();
	if (!d) return;
	await d.delete('sessions', id);
}

/** Newest first — the sidebar rail's display order (SidebarRecents anatomy). */
export async function listSessions(): Promise<PersistedSession[]> {
	const d = await db();
	if (!d) return [];
	const rows = (await d.getAllFromIndex('sessions', 'createdAt')) as PersistedSession[];
	return rows.reverse();
}

/** Appends and trims to the newest DEAD_LETTER_CAP inside one transaction
 * (ring semantics from issue #12). Callers treat this as fire-and-forget. */
export async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
	const d = await db();
	if (!d) return;
	const tx = d.transaction('deadLetters', 'readwrite');
	await tx.store.add(stripSecrets(entry));
	const count = await tx.store.count();
	if (count > DEAD_LETTER_CAP) {
		let cursor = await tx.store.openCursor();
		let toDelete = count - DEAD_LETTER_CAP;
		while (cursor && toDelete > 0) {
			await cursor.delete();
			toDelete -= 1;
			cursor = await cursor.continue();
		}
	}
	await tx.done;
}

export async function loadDeadLetters(): Promise<DeadLetterEntry[]> {
	const d = await db();
	if (!d) return [];
	return (await d.getAll('deadLetters')) as DeadLetterEntry[];
}

/** "Clear all local data" (spec §6): wipes every store, then re-opens an
 * empty DB so the app keeps working without a reload. The settings button
 * (#11) additionally reloads the page for a full in-memory wipe. */
export async function clearAllLocalData(): Promise<void> {
	conn?.close();
	conn = undefined;
	persistent = false;
	ready = null;
	if (typeof indexedDB !== 'undefined') {
		try {
			await deleteDB(DB_NAME);
		} catch {
			// best-effort — spec §6 already treats the layer as disposable
		}
	}
	await initPersistence();
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
	const d = await db();
	if (!d) return {};
	const out: Record<string, unknown[]> = {};
	for (const name of d.objectStoreNames) out[name] = await d.getAll(name);
	return out;
}
