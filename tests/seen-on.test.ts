import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	_closeForTests,
	clearAllLocalData,
	dumpAllForTests,
	initPersistence
} from '$lib/db';
import { recordSeenOn, seenOnRelays, SEEN_ON_CAP } from '$lib/net/seen-on';

// recordSeenOn is fire-and-forget (void), so each assertion waits for the
// real condition — the IDB write becoming visible to seenOnRelays — rather
// than guessing a wall-clock sleep.
async function expectSeenOn(eventId: string, expected: string[]): Promise<void> {
	await vi.waitFor(async () => {
		expect(await seenOnRelays(eventId)).toEqual(expected);
	});
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

afterEach(() => {
	_closeForTests();
});

describe('seen-on relay registry (issue #31, spec §8)', () => {
	it('records observations in insertion order and persists across a reopen', async () => {
		recordSeenOn('e1', 'wss://a');
		recordSeenOn('e1', 'wss://b');
		await expectSeenOn('e1', ['wss://a', 'wss://b']);

		// Simulated reload: hints come back from IDB, not memory.
		_closeForTests();
		await initPersistence();
		expect(await seenOnRelays('e1')).toEqual(['wss://a', 'wss://b']);
	});

	it('keeps hints first-observed: re-observation neither reorders nor duplicates', async () => {
		recordSeenOn('e1', 'wss://a');
		recordSeenOn('e1', 'wss://b');
		recordSeenOn('e1', 'wss://a'); // re-observed: must not promote or repeat
		await expectSeenOn('e1', ['wss://a', 'wss://b']);
	});

	it(`caps at ${SEEN_ON_CAP}, dropping later arrivals beyond the cap`, async () => {
		for (let i = 1; i <= SEEN_ON_CAP + 2; i++) recordSeenOn('e1', `wss://r${i}`);
		await vi.waitFor(async () => {
			const hints = await seenOnRelays('e1');
			expect(hints).toHaveLength(SEEN_ON_CAP);
			expect(hints[0]).toBe('wss://r1');
		});
	});

	it('keeps events independent and returns [] for unobserved events', async () => {
		recordSeenOn('e1', 'wss://a');
		await expectSeenOn('e1', ['wss://a']);
		expect(await seenOnRelays('e2')).toEqual([]);
	});

	it('writes rows into the relayHints store with the v6 schema', async () => {
		recordSeenOn('e1', 'wss://a');
		recordSeenOn('e1', 'wss://b');
		await expectSeenOn('e1', ['wss://a', 'wss://b']);
		const dump = await dumpAllForTests();
		expect(dump.relayHints).toEqual([{ eventId: 'e1', relays: ['wss://a', 'wss://b'] }]);
	});

	it('silently degrades when IndexedDB is unavailable (no throw, no hints)', async () => {
		const real = globalThis.indexedDB;
		// @ts-expect-error simulating private-mode absence
		delete globalThis.indexedDB;
		try {
			_closeForTests();
			await initPersistence();
			expect(() => recordSeenOn('e1', 'wss://a')).not.toThrow();
			expect(await seenOnRelays('e1')).toEqual([]);
		} finally {
			globalThis.indexedDB = real;
		}
	});
});
