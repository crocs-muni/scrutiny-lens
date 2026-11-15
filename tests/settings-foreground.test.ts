// Relay pool across tabs (issue #151, spec §6): a tab that returns to the
// foreground re-reads the persisted pool, and an open Settings editor rebases
// only while pristine. The "other tab" is modeled by writing the settings
// record straight through the store — that IS the cross-tab mechanism
// (IndexedDB last-write-wins), so no second settings singleton is needed and
// no real DOM event is synthesized: watchForeground takes its event source as
// a parameter.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_closeForTests,
	clearAllLocalData,
	initPersistence,
	loadSettings,
	saveSettings
} from '$lib/db';
import {
	defaultSettings,
	rebaseRelayDrafts,
	rebasedRelayPool,
	resetSettings,
	settings,
	watchForeground,
	type ForegroundSource
} from '../src/lib/settings.svelte';

const HOME = ['wss://home.example'];
const OTHER = ['wss://other-a.example', 'wss://other-b.example'];

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
});

afterEach(() => {
	_closeForTests();
});

/** One fake tab's document: manual visibility, manual dispatch, so a test
 * names the edge it is exercising instead of racing a real browser. */
interface FakeTab extends ForegroundSource {
	show(state: 'visible' | 'hidden'): void;
}

function fakeTab(): FakeTab {
	let state = 'hidden';
	const listeners = new Set<() => void>();
	return {
		get visibilityState() {
			return state;
		},
		addEventListener: (type, listener) => {
			if (type === 'visibilitychange') listeners.add(listener);
		},
		removeEventListener: (type, listener) => {
			if (type === 'visibilitychange') listeners.delete(listener);
		},
		show(next) {
			state = next;
			for (const listener of listeners) listener();
		}
	};
}

describe('rebasedRelayPool (issue #151: the pure adopt decision)', () => {
	it('returns the canonical persisted pool when it differs from the live one', () => {
		expect(rebasedRelayPool(HOME, ['wss://a.example/', 'wss://a.example', 'wss://b.example'])).toEqual(
			['wss://a.example', 'wss://b.example']
		);
	});

	it('returns null for an identical pool, including canonical-equal spellings', () => {
		expect(rebasedRelayPool(HOME, [...HOME])).toBeNull();
		expect(rebasedRelayPool(HOME, ['wss://home.example/'])).toBeNull();
	});

	it('returns null when the record carries no pool (fresh install, memory-only tab)', () => {
		expect(rebasedRelayPool(HOME, undefined)).toBeNull();
	});

	it('falls back to defaults for a legacy row with nothing valid left after folding', () => {
		// Same rule boot hydrate applies (#131): a garbage record must never
		// hand createTransport a pool it would reject.
		expect(rebasedRelayPool(HOME, ['https://not-a-relay', ''])).toEqual(defaultSettings.relays);
	});
});

describe('rebaseRelayDrafts (issue #151: the editor half)', () => {
	it('a pristine editor rebases onto the pool', () => {
		expect(rebaseRelayDrafts(['wss://stale.example'], OTHER, false)).toEqual(OTHER);
	});

	it('a pristine editor already showing the pool is left alone (no churn)', () => {
		expect(rebaseRelayDrafts([...OTHER], OTHER, false)).toBeNull();
	});

	it('a dirty editor keeps its drafts whatever the pool says', () => {
		// #151: unsaved typing is the fresher truth. Never silently overwritten.
		expect(rebaseRelayDrafts(['wss://typed.example'], OTHER, true)).toBeNull();
	});
});

describe('refresh (issue #151: a foreground tab adopts the persisted pool)', () => {
	it('adopts a pool another tab saved once this tab comes back to the foreground', async () => {
		await saveSettings({ relays: HOME });
		await settings.hydrate();
		expect(settings.relays).toEqual(HOME);

		// Tab A commits a new pool (last-write-wins at the store level).
		await saveSettings({ relays: OTHER });

		const tab = fakeTab();
		const stop = watchForeground(tab);
		tab.show('visible');
		await vi.waitFor(() => expect(settings.relays).toEqual(OTHER));
		stop();
	});

	it('the hidden edge adopts nothing — leaving a tab is not a read', async () => {
		await saveSettings({ relays: HOME });
		await settings.hydrate();
		await saveSettings({ relays: OTHER });
		const tab = fakeTab();
		const stop = watchForeground(tab);
		const refreshes = vi.spyOn(settings, 'refresh');
		tab.show('hidden');
		// Dispatch is synchronous, so the decision is observable without a wait.
		expect(refreshes).not.toHaveBeenCalled();
		expect(settings.relays).toEqual(HOME);
		refreshes.mockRestore();
		stop();
	});

	it('the uninstaller detaches the listener', async () => {
		await saveSettings({ relays: HOME });
		await settings.hydrate();
		const tab = fakeTab();
		watchForeground(tab)();
		const refreshes = vi.spyOn(settings, 'refresh');
		tab.show('visible');
		expect(refreshes).not.toHaveBeenCalled();
		refreshes.mockRestore();
	});

	it('an identical pool is a no-op — the live array is not replaced', async () => {
		await saveSettings({ relays: HOME });
		await settings.hydrate();
		const live = settings.relays;
		// Another tab re-saves the same relay in its slashed spelling (#131).
		await saveSettings({ relays: ['wss://home.example/'] });
		await settings.refresh();
		expect(settings.relays).toBe(live);
	});

	it('no persisted pool adopts nothing', async () => {
		await settings.hydrate();
		const live = settings.relays;
		await settings.refresh();
		expect(settings.relays).toBe(live);
	});

	it('does not read before boot hydration (hydrate owns the first read)', async () => {
		await saveSettings({ relays: OTHER });
		await settings.refresh();
		expect(settings.relays).toEqual(defaultSettings.relays);
	});

	it('a failed save is never overwritten by a foreground read', async () => {
		// persistState 'failed' is the UI's truth for "your pool did not
		// persist"; adopting the stale record would silently drop the edit.
		await saveSettings({ relays: HOME });
		await settings.hydrate();
		settings.persistState = 'failed';
		await saveSettings({ relays: OTHER });
		await settings.refresh();
		expect(settings.relays).toEqual(HOME);
	});
});

describe('a dirty Settings editor during a foreground rebase (issue #151)', () => {
	it('keeps the drafts, shows the adopted pool, and never clobbers the record', async () => {
		await saveSettings({ relays: HOME });
		await settings.hydrate();

		// The editor holds typed-but-uncommitted text while tab A saves.
		const drafts = ['wss://typed.example'];
		await saveSettings({ relays: OTHER });
		await settings.refresh();

		// Display: the dirty drafts stay exactly as typed…
		expect(rebaseRelayDrafts(drafts, settings.relays, true)).toBeNull();
		// …the store's truth (what the next query snapshots) is the new pool…
		expect(settings.relays).toEqual(OTHER);
		// …and the refresh itself wrote nothing, so tab A's pool is intact.
		expect((await loadSettings())?.relays).toEqual(OTHER);
	});
});
