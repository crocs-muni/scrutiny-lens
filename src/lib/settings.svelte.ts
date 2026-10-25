// Settings flow (issue #11, spec §5/§6): runes state is the in-memory truth;
// the persisted half (endpoint, model, relays, appearance) saves through the
// #12 store with a real outcome (SaveOutcome → persistState, spec §2 never-lie)
// and hydrates once at boot behind the ready() barrier. The API key is
// memory-only by type — PersistedSettings cannot represent it — and every
// entry arms the redaction strip via registerSecret().

import {
	initPersistence,
	loadSettings,
	registerSecret,
	saveSettings,
	type PersistedSettings,
	type SaveOutcome
} from '$lib/db';
import { canonicalRelayUrls } from '$lib/net/relay-url';

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

/** Single-model auto-select (spec §5): when the live model list resolves to
 * exactly one model and the current model is empty or is the value this rule
 * last filled, follow it. Any other current value — a user pick or a
 * persisted choice — is never clobbered. Returns the model to select, or
 * null for "no change". */
export function nextAutoModel(
	models: readonly string[],
	current: string,
	previousAuto: string | null
): string | null {
	if (models.length !== 1) return null;
	const only = models[0];
	if (current !== '' && current !== previousAuto) return null;
	return only;
}

/** Fields written through setters before hydration — hydrate() skips them
 * so a late boot can never clobber a live user edit (settings hydrate
 * merged unconditionally before the ready() barrier existed). Module scope,
 * not a private field: plain non-reactive bookkeeping nothing renders off. */
const dirtyFields = new Set<keyof PersistedSettings>();
/** The memoized ready() promise — see Settings.ready(). */
let bootBarrier: Promise<void> | null = null;

class Settings {
	endpoint = $state(defaultSettings.endpoint);
	model = $state(defaultSettings.model);
	relays = $state<string[]>([...defaultSettings.relays]);
	appearance = $state<Appearance>(defaultSettings.appearance);
	/** Memory-only by spec §6; registerSecret strips it from every write path. */
	apiKey = $state('');

	/** Boot truth for awaiting surfaces: true once the one hydrate ran. */
	hydrated = $state(false);
	/** Persistence truth for the settings UI (spec §2 never-lie): what the
	 * last save actually did, never an optimistic "saved". */
	persistState = $state<'idle' | 'saving' | 'saved' | 'failed' | 'unavailable'>('idle');

	/** Single-flight boot barrier: awaits initPersistence() + the one
	 * hydrate(). Memoized so layout, search start, share resolve and profile
	 * lookups can all await it without re-hydrating (a second hydrate() runs
	 * a second loadSettings race against edits; the dirty guard below is the
	 * belt, this is the suspenders). */
	ready(): Promise<void> {
		bootBarrier ??= initPersistence().then(() => this.hydrate());
		return bootBarrier;
	}

	/** Merge persisted values over the defaults. Only fields the record
	 * actually carries override — partial records die to defaults (spec §6:
	 * the store accumulates patches until the flow has saved them all) —
	 * and only fields no setter touched first: a pre-hydration edit is the
	 * user's freshest truth. */
	async hydrate(): Promise<void> {
		const persisted = await loadSettings();
		if (persisted?.endpoint !== undefined && !dirtyFields.has('endpoint'))
			this.endpoint = persisted.endpoint;
		if (persisted?.model !== undefined && !dirtyFields.has('model')) this.model = persisted.model;
		if (persisted?.relays !== undefined && !dirtyFields.has('relays')) {
			// Canonicalize on read (issue #131): a legacy record can carry
			// slashed/dup variants that would double-count one relay in every
			// boundary keyed on the string. Empty after folding (all-invalid
			// legacy row) keeps defaults rather than a pool createTransport
			// would reject — hydrate must never brick the boot.
			const canonical = canonicalRelayUrls(persisted.relays);
			this.relays = canonical.urls.length > 0 ? canonical.urls : [...defaultSettings.relays];
		}
		if (persisted?.appearance !== undefined && !dirtyFields.has('appearance'))
			this.appearance = persisted.appearance;
		this.hydrated = true;
	}

	/** One save, folded into persistState. Save failures never throw (spec
	 * §2): the state carries the truth the settings UI renders. */
	async #save(patch: Partial<PersistedSettings>): Promise<SaveOutcome> {
		this.persistState = 'saving';
		const outcome = await saveSettings(patch);
		this.persistState = outcome;
		return outcome;
	}

	async setEndpoint(endpoint: string): Promise<SaveOutcome> {
		this.endpoint = endpoint.trim();
		dirtyFields.add('endpoint');
		return this.#save({ endpoint: this.endpoint });
	}

	async setModel(model: string): Promise<SaveOutcome> {
		this.model = model;
		dirtyFields.add('model');
		return this.#save({ model });
	}

	async setAppearance(appearance: Appearance): Promise<SaveOutcome> {
		this.appearance = appearance;
		dirtyFields.add('appearance');
		return this.#save({ appearance });
	}

	/** Validates the whole list before touching state, so a rejected edit
	 * neither mutates the pool nor lands in the store. A write that fails
	 * (quota, abort) is retried exactly once — transient IDB aborts are the
	 * common case — while 'unavailable' (private window/blocked storage) is
	 * permanent for this tab and is never retried. Never throws on a save
	 * failure; the returned outcome is the truth. */
	async setRelays(urls: string[]): Promise<SaveOutcome> {
		// Canonicalize BEFORE validating bounds (issue #131): `wss://x` and
		// `wss://x/` are ONE relay — collapsing them first is the dedupe the
		// pool owes anyway, and RELAY_MIN/MAX then count real endpoints.
		// Silently dropping invalid entries here would HIDE a typo the user
		// just typed, so entries that fail canonicalization still throw below.
		const list = urls.map((u) => u.trim());
		const canonical = canonicalRelayUrls(list);
		if (canonical.issues.length > 0)
			throw new Error(`"${canonical.issues[0].input}" is not a ws:// or wss:// URL.`);
		if (canonical.urls.length < RELAY_MIN || canonical.urls.length > RELAY_MAX)
			throw new Error(
				`Relay pool needs ${RELAY_MIN}–${RELAY_MAX} entries, got ${canonical.urls.length}.`
			);
		this.relays = canonical.urls;
		dirtyFields.add('relays');
		this.persistState = 'saving';
		let outcome = await saveSettings({ relays: canonical.urls });
		if (outcome === 'failed') outcome = await saveSettings({ relays: canonical.urls });
		this.persistState = outcome;
		return outcome;
	}

	/** Memory-only (spec §6). registerSecret is called on every non-empty
	 * entry so the db layer strips the key from anything later serialized —
	 * clearing the field deliberately leaves the strip armed. */
	setApiKey(key: string): void {
		const trimmed = key.trim();
		if (trimmed !== '') registerSecret(trimmed);
		this.apiKey = trimmed;
	}

	/** Test-seam body — resetSettings delegates here because the module-level
	 * barrier/dirty state is unreachable from that wrapper. */
	reset(): void {
		this.endpoint = defaultSettings.endpoint;
		this.model = defaultSettings.model;
		this.relays = [...defaultSettings.relays];
		this.appearance = defaultSettings.appearance;
		this.apiKey = '';
		dirtyFields.clear();
		bootBarrier = null;
		this.hydrated = false;
		this.persistState = 'idle';
	}
}

export const settings = new Settings();

/** Test seam — the singleton survives across spec files (same shape as
 * resetShell). Runes compile to state only under the svelte plugin, so
 * assignments go through the class instance; reset() also clears the
 * private barrier/dirty memoization. */
export function resetSettings(): void {
	settings.reset();
}
