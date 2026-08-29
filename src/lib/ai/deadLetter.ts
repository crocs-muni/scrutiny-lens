/**
 * Dead-letter sink for rejected AI artifacts (spec §7 conformance evidence).
 * In-memory ring for now — the IndexedDB-backed store lands with the
 * persistence layer (issue #12), which swaps this module's backend only.
 */

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

export function writeDeadLetter(
	entityType: string,
	entityId: string,
	schemaVersion: string,
	profile: string,
	model: string,
	payload: unknown,
	reason: string
): void {
	ring.push({
		entityType,
		entityId,
		schemaVersion,
		profile,
		model,
		payload,
		reason,
		at: Date.now()
	});
	if (ring.length > MAX_ENTRIES) ring.shift();
	console.warn(`[dead-letter] ${entityType}:${entityId} — ${reason}`);
}

export function deadLetters(): readonly DeadLetterEntry[] {
	return ring;
}

/** Test seam. */
export function clearDeadLetters(): void {
	ring.length = 0;
}
