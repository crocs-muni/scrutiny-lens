// Settings flow (issue #11, spec §5/§6): runes state is the in-memory truth;
// the persisted half (endpoint, model, relays, appearance) persists
// fire-and-forget through the #12 store and hydrates at boot from the layout.
// The API key is memory-only by type — PersistedSettings cannot represent it —
// and every entry arms the redaction strip via registerSecret().

import { loadSettings, registerSecret, saveSettings } from '$lib/db';
import {
	DEFAULT_APPEARANCE,
	DEFAULT_ENDPOINT,
	DEFAULT_RELAYS,
	RELAY_MAX,
	RELAY_MIN,
	isValidRelayUrl,
	type Appearance
} from '$lib/config';

/** The defaults the store overlays — exported for tests and reset. */
export const defaultSettings = {
	endpoint: DEFAULT_ENDPOINT,
	model: '',
	relays: [...DEFAULT_RELAYS] as string[],
	appearance: DEFAULT_APPEARANCE as Appearance
};

class Settings {
	endpoint = $state(DEFAULT_ENDPOINT);
	model = $state('');
	relays = $state<string[]>([...DEFAULT_RELAYS]);
	appearance = $state<Appearance>(DEFAULT_APPEARANCE);
	/** Memory-only by spec §6; registerSecret strips it from every write path. */
	apiKey = $state('');

	/** Merge persisted values over the defaults. Only fields the record
	 * actually carries override — partial records die to defaults (spec §6:
	 * the store accumulates patches until the flow has saved them all). */
	async hydrate(): Promise<void> {
		const persisted = await loadSettings();
		if (!persisted) return;
		if (persisted.endpoint !== undefined) this.endpoint = persisted.endpoint;
		if (persisted.model !== undefined) this.model = persisted.model;
		if (persisted.relays !== undefined) this.relays = [...persisted.relays];
		if (persisted.appearance !== undefined) this.appearance = persisted.appearance;
	}

	setEndpoint(endpoint: string): Promise<void> {
		this.endpoint = endpoint.trim();
		return saveSettings({ endpoint: this.endpoint });
	}

	setModel(model: string): Promise<void> {
		this.model = model;
		return saveSettings({ model });
	}

	setAppearance(appearance: Appearance): Promise<void> {
		this.appearance = appearance;
		return saveSettings({ appearance });
	}

	/** Validates the whole list before touching state, so a rejected edit
	 * neither mutates the pool nor lands in the store. */
	async setRelays(urls: string[]): Promise<void> {
		const list = urls.map((u) => u.trim());
		if (list.length < RELAY_MIN || list.length > RELAY_MAX)
			throw new Error(`Relay pool needs ${RELAY_MIN}–${RELAY_MAX} entries, got ${list.length}.`);
		for (const url of list)
			if (!isValidRelayUrl(url)) throw new Error(`"${url}" is not a ws:// or wss:// URL.`);
		if (new Set(list).size !== list.length) throw new Error('Relay list contains a duplicate.');
		this.relays = list;
		return saveSettings({ relays: list });
	}

	/** Memory-only (spec §6). registerSecret is called on every non-empty
	 * entry so the db layer strips the key from anything later serialized —
	 * clearing the field deliberately leaves the strip armed. */
	setApiKey(key: string): void {
		const trimmed = key.trim();
		if (trimmed !== '') registerSecret(trimmed);
		this.apiKey = trimmed;
	}
}

export const settings = new Settings();

/** Test seam — the singleton survives across spec files (same shape as
 * resetShell). Runes compile to state only under the svelte plugin, so
 * assignments go through the class instance. */
export function resetSettings(): void {
	settings.endpoint = defaultSettings.endpoint;
	settings.model = defaultSettings.model;
	settings.relays = [...defaultSettings.relays];
	settings.appearance = defaultSettings.appearance;
	settings.apiKey = '';
}
