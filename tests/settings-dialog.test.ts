// Settings dialog save-truth copy (issue #131 editor half, spec §2
// never-lie). The dialog itself is browser-bound (focus/blur, backdrop
// drag, IndexedDB) and stays untested here — commitRelays, the rebase
// $effect, and closeDialog's blur-before-unmount are the browser leftovers;
// this file covers the one piece that is a pure function.

import { describe, expect, it } from 'vitest';
	import { persistNote, type PersistNoteState } from '../src/lib/components/shell/persist-note';

describe('persistNote', () => {
	it.each<[PersistNoteState, string]>([
		['saved', 'saved on this device'],
		['unavailable', 'not saved - storage unavailable; this tab only'],
		['failed', 'not saved - edit again to retry']
	])('maps %s to its honest footer line', (state, expected) => {
		expect(persistNote(state)).toEqual(expected);
	});

	it.each<PersistNoteState>(['idle', 'saving'])('renders nothing while %s — no optimistic claim', (state) => {
		expect(persistNote(state)).toEqual('');
	});

	it('never claims automatic saving', () => {
		// The old footer's lie, verbatim: nothing this mapping can produce
		// may promise the pool persists itself once merely valid.
		for (const state of ['idle', 'saving', 'saved', 'failed', 'unavailable'] as const)
			expect(persistNote(state)).not.toMatch(/automatic/i);
	});
});
