/** Save-truth copy for the settings dialog (issue #131 editor half, spec §2
 * never-lie): `persistState` is what the last save ACTUALLY did, so the
 * footer renders it instead of the old "saved automatically once valid"
 * claim — a save can silently no-op (quota abort, private window), and the
 * text must not promise otherwise. `saving`/`idle` render nothing: a blank
 * footer is honest mid-flight, an optimistic string is not.
 *
 * Kept out of the .svelte file so the mapping is node-testable without
 * mounting the dialog. */

/** The settings store's SaveOutcome states plus the two pre-save ones;
 * mirrors settings.persistState's declared union (it widens SaveOutcome
 * with 'idle'|'saving' — relisted here because the store annotates the
 * union inline). */
export type PersistNoteState = 'idle' | 'saving' | 'saved' | 'failed' | 'unavailable';

export function persistNote(state: PersistNoteState): string {
	switch (state) {
		case 'saved':
			// Local-only persistence (spec §6) — say where it lives.
			return 'saved on this device';
		case 'unavailable':
			// Storage never opened (private window/blocked IDB): the in-memory
			// pool works, nothing outlives the tab.
			return 'not saved - storage unavailable; this tab only';
		case 'failed':
			// The store already retried once; the user's next edit re-runs the save.
			return 'not saved - edit again to retry';
		default:
			return '';
	}
}
