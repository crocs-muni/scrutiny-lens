/**
 * Synchronous in-memory mirror for its readers; IndexedDB-backed since issue
 * #12. Writes persist fire-and-forget so call sites stay sync; the layout
 * hydrates the mirror once at boot via hydrateDeadLetters().
 */

import { appendDeadLetter, loadDeadLetters } from '$lib/db';

export interface DeadLetterEntry {
	entityType: string;
	entityId: string;
	schemaVersion: string;
	profile: string;
	model: string;
	payload: unknown;
	reason: string;
	at: number;
}

const MAX_ENTRIES = 200;
const ring: DeadLetterEntry[] = [];

export function writeDeadLetter(entry: Omit<DeadLetterEntry, 'at'>): void {
	const stamped = { ...entry, at: Date.now() };
	ring.push(stamped);
	if (ring.length > MAX_ENTRIES) ring.shift();
	// Best-effort persist; failures are the spec §6 silent degrade, not errors.
	void appendDeadLetter(stamped).catch(() => {});
	console.warn(`[dead-letter] ${entry.entityType}:${entry.entityId} — ${entry.reason}`);
}

/** Hydrates the mirror from the persisted ring; the layout calls this once
 * after initPersistence(). Sync readers (and tests) keep working without it. */
export async function hydrateDeadLetters(): Promise<void> {
	const persisted = await loadDeadLetters();
	ring.splice(0, ring.length, ...persisted.slice(-MAX_ENTRIES));
}

export function deadLetters(): readonly DeadLetterEntry[] {
	return ring;
}

/** Test seam. */
export function clearDeadLetters(): void {
	ring.length = 0;
}
