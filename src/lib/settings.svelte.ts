// Settings flow (issue #11, spec §5/§6): runes state is the in-memory truth;
// the persisted half (endpoint, model, relays, appearance) saves through the
// #12 store with a real outcome (SaveOutcome → persistState, spec §2 never-lie)
// and hydrates once at boot behind the ready() barrier. The API key is not a
// PersistedSettings field (IndexedDB must never hold it): it rides this tab's
// session storage instead, and every entry — typed or restored at boot —
// arms the redaction strip via registerSecret().
//
// Issue #151 adds the one cross-tab path: a tab returning to the foreground
// re-reads the persisted relay pool (refresh(), wired by watchForeground),
// because IndexedDB is last-write-wins and nothing pushes between tabs.

import {
	initPersistence,
	loadSettings,
	registerSecret,
	saveSettings,
	type PersistedSettings,
	type SaveOutcome
} from '$lib/db';
import { canonicalRelayUrls, describeRelayIssue } from '$lib/net/relay-url';

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

/** The pool a persisted record means (issue #131): canonicalized on read, and
 * defaults when nothing real survives folding — a legacy row full of slashed
 * duplicates or invalid entries must never hand createTransport a list it
 * rejects. One rule for boot hydrate and the #151 foreground refresh, so the
 * two entry points cannot disagree about the same record. */
function poolFromPersisted(relays: readonly string[]): string[] {
	const canonical = canonicalRelayUrls(relays);
	return canonical.urls.length > 0 ? canonical.urls : [...defaultSettings.relays];
}

/** Relay-pool identity: order IS part of the pool (the editor shows it in
 * this order and a run snapshots it), so this compares element-wise rather
 * than as a set. */
export function sameRelayPool(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((url, i) => url === b[i]);
}

/** Issue #151: the pool a foreground refresh adopts, or null for "nothing to
 * adopt". Pure so the three cases — a pool another tab persisted, a pool
 * this tab already shows (returning a fresh array would be reactive churn for
 * every focus), and no persisted pool at all (memory-only tab) — are testable
 * without IndexedDB. */
export function rebasedRelayPool(
	local: readonly string[],
	persisted: readonly string[] | undefined
): string[] | null {
	if (persisted === undefined) return null;
	const next = poolFromPersisted(persisted);
	return sameRelayPool(local, next) ? null : next;
}

/** Issue #151: what the Settings relay editor shows when the committed pool
 * moves underneath it — a foreground refresh can now replace settings.relays
 * while the dialog is open. Pristine drafts follow the pool: the editor
 * showing anything other than the pool the app queries is the #131 lie.
 * Dirty drafts are the fresher truth and are NEVER silently overwritten —
 * the user commits or discards them, and only that commit writes (IndexedDB
 * stays last-write-wins; merge semantics for concurrent edits are out of
 * scope for #151). null = leave the drafts alone (dirty, or already equal),
 * so the dialog's rebase $effect writes no state it would re-derive. */
export function rebaseRelayDrafts(
	drafts: readonly string[],
	pool: readonly string[],
	dirty: boolean
): string[] | null {
	if (dirty) return null;
	return sameRelayPool(drafts, pool) ? null : [...pool];
}

/** Fields written through setters before hydration — hydrate() skips them
 * so a late boot can never clobber a live user edit (settings hydrate
 * merged unconditionally before the ready() barrier existed). Module scope,
 * not a private field: plain non-reactive bookkeeping nothing renders off. */
const dirtyFields = new Set<keyof PersistedSettings>();
/** The memoized ready() promise — see Settings.ready(). */
let bootBarrier: Promise<void> | null = null;

/** Spec §6: the key lives in this tab's session storage — a reload keeps it,
 * closing the tab forgets it, and nothing here ever reaches IndexedDB. The
 * seam is module scope so node tests can inject a storage they do not have;
 * production reads the real sessionStorage per call because a private window
 * throws on ACCESS, not on lookup. */
const SESSION_KEY = 'scrutiny.apiKey';

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let keyStorageForTests: KeyStorage | null | undefined;

function keyStorage(): KeyStorage | null {
	if (keyStorageForTests !== undefined) return keyStorageForTests;
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null; // a private window can refuse the object outright
	}
}

function readSessionKey(): string {
	try {
		return keyStorage()?.getItem(SESSION_KEY) ?? '';
	} catch {
		return '';
	}
}

/** '' removes the entry. Every failure stays silent: an unavailable storage
 * degrades to the memory-only behavior this store had before (spec §6). */
function writeSessionKey(key: string): void {
	try {
		const store = keyStorage();
		if (store === null) return;
		if (key === '') store.removeItem(SESSION_KEY);
		else store.setItem(SESSION_KEY, key);
	} catch {
		// memory-only for this tab; no user-facing error to tell
	}
}

/** "Clear all local data" cannot reach session storage, so the Settings
 * button calls this too — the button means "remove everything I kept". */
export function clearSessionKey(): void {
	writeSessionKey('');
}

/** Test seam: node has no sessionStorage, so specs inject a Map-backed one. */
export function _setKeyStorageForTests(storage: KeyStorage | null | undefined): void {
	keyStorageForTests = storage;
}

class Settings {
	endpoint = $state(defaultSettings.endpoint);
	model = $state(defaultSettings.model);
	relays = $state<string[]>([...defaultSettings.relays]);
	appearance = $state<Appearance>(defaultSettings.appearance);
	/** This tab's session only (spec §6); registerSecret strips it from every
	 * write path. */
	apiKey = $state('');

	/** Boot truth for awaiting surfaces: true once the one hydrate ran. */
	hydrated = $state(false);
	/** Persistence truth for the settings UI (spec §2 never-lie): what the
	 * last save actually did, never an optimistic "saved". */
	persistState = $state<'idle' | 'saving' | 'saved' | 'failed' | 'unavailable'>('idle');

	/** Monotone count of writes this tab issued (issue #151): a foreground
	 * read that STARTED before a newer local write must not apply its stale
	 * snapshot over the user's edit. Non-reactive — nothing renders off it. */
	#writes = 0;

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
			this.relays = poolFromPersisted(persisted.relays);
		}
		if (persisted?.appearance !== undefined && !dirtyFields.has('appearance'))
			this.appearance = persisted.appearance;
		// Spec §6: the key survives a reload in session storage. A restored key
		// arms the redaction strip exactly like a typed one, or the db layer
		// would happily serialize a key it was never told about.
		if (this.apiKey === '') {
			const restored = readSessionKey();
			if (restored !== '') {
				registerSecret(restored);
				this.apiKey = restored;
			}
		}
		this.hydrated = true;
	}

	/** Issue #151: adopt the relay pool another tab persisted, on return to
	 * the foreground. Nothing pushes across tabs — IndexedDB is last-write-
	 * wins, and a BroadcastChannel would be a second source of truth for a
	 * 1–4 entry list, which #151 rules out for this cycle; so a tab re-reads
	 * the record the platform says it may now be behind on.
	 *
	 * Guards, in order:
	 *  - nothing read yet → boot's hydrate() owns the first read (a refresh
	 *    here would race it with the same record).
	 *  - a save in flight, or a failed save → this tab holds unsaved truth the
	 *    record does not carry; adopting the record would silently discard
	 *    the user's edit. 'failed' is sticky until the user edits again
	 *    (persistState is the UI's truth), and that is the intent: a pool
	 *    that did not persist keeps showing here.
	 *  - a write landed while the read was in flight (#writes) → that write
	 *    is fresher than the record this read saw.
	 *
	 * Never writes, so a foreground refresh cannot clobber the persisted
	 * pool; the Settings editor's half of the rule is rebaseRelayDrafts.
	 * Relays only: the pool is the field two tabs can disagree about without
	 * a reload (every query snapshots it), which is what #151 reports. */
	async refresh(): Promise<void> {
		if (!this.hydrated) return;
		if (this.persistState === 'saving' || this.persistState === 'failed') return;
		const seq = this.#writes;
		const persisted = await loadSettings();
		if (seq !== this.#writes) return;
		const next = rebasedRelayPool(this.relays, persisted?.relays);
		if (next !== null) this.relays = next;
	}

	/** One save, folded into persistState. Save failures never throw (spec
	 * §2): the state carries the truth the settings UI renders. */
	async #save(patch: Partial<PersistedSettings>): Promise<SaveOutcome> {
		this.#writes += 1;
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
		if (canonical.issues.length > 0) throw new Error(describeRelayIssue(canonical.issues[0]));
		if (canonical.urls.length < RELAY_MIN || canonical.urls.length > RELAY_MAX)
			throw new Error(
				`Relay pool needs ${RELAY_MIN}–${RELAY_MAX} entries, got ${canonical.urls.length}.`
			);
		this.relays = canonical.urls;
		dirtyFields.add('relays');
		// Same epoch bump as #save (this path retries its own save, issue #131).
		this.#writes += 1;
		this.persistState = 'saving';
		let outcome = await saveSettings({ relays: canonical.urls });
		if (outcome === 'failed') outcome = await saveSettings({ relays: canonical.urls });
		this.persistState = outcome;
		return outcome;
	}

	/** Spec §6: this tab's session storage, never IndexedDB. registerSecret is
	 * called on every non-empty entry so the db layer strips the key from
	 * anything later serialized — clearing the field deliberately leaves the
	 * strip armed. */
	setApiKey(key: string): void {
		const trimmed = key.trim();
		if (trimmed !== '') registerSecret(trimmed);
		writeSessionKey(trimmed);
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
		clearSessionKey();
		dirtyFields.clear();
		bootBarrier = null;
		this.#writes = 0;
		this.hydrated = false;
		this.persistState = 'idle';
	}
}

export const settings = new Settings();

/** The slice of `document` a foreground refresh needs, narrowed so node tests
 * can hand in a fake instead of synthesizing DOM events (same seam shape as
 * KeyStorage above) and so the SSR import path can stay document-free. */
export interface ForegroundSource {
	addEventListener(type: 'visibilitychange', listener: () => void): void;
	removeEventListener(type: 'visibilitychange', listener: () => void): void;
	readonly visibilityState: string;
}

/** Issue #151: adopt another tab's relay pool when this one comes back into
 * the foreground. `visibilitychange` — not `focus`, not a timer — is the
 * platform signal that already means "the user is looking at this tab now",
 * and it is the event a browser already fires on every tab switch, so there
 * is no polling loop and no second cross-tab channel. Returns the
 * uninstaller: tests install one per fake tab, and nothing else may stack
 * listeners on the real document.
 *
 * Only the visible edge refreshes: the hidden edge is this tab LEAVING, where
 * a read costs an IndexedDB wake-up for a pool nobody is looking at. */
export function watchForeground(source: ForegroundSource): () => void {
	const onVisibilityChange = (): void => {
		if (source.visibilityState !== 'visible') return;
		void settings.refresh();
	};
	source.addEventListener('visibilitychange', onVisibilityChange);
	return () => source.removeEventListener('visibilitychange', onVisibilityChange);
}

// Installed once at import: +layout imports this module before any query can
// run, so there is no call site to forget. The guard is the SSR/prerender
// path, not a second code path — no document means nothing to listen to.
if (typeof document !== 'undefined') watchForeground(document);

/** Test seam — the singleton survives across spec files (same shape as
 * resetShell). Runes compile to state only under the svelte plugin, so
 * assignments go through the class instance; reset() also clears the
 * private barrier/dirty memoization. */
export function resetSettings(): void {
	settings.reset();
}
