// Local overrides over the reviewed trusted-publisher list (issue #214,
// spec §2/§3, ADR 0004). The store owns the device-local add/remove state;
// the set arithmetic and the branded fabric provider stay in $lib/trust so
// the admission index consumes exactly one implementation.
import {
	initPersistence,
	loadTrustOverrides,
	saveTrustOverrides,
	type PersistedTrustOverrides,
	type SaveOutcome
} from '$lib/db';
import { describePubkeyIssue, parsePubkeyInput } from '$lib/publisher';
import { BUNDLED_TRUSTED, createTrustProvider, effectiveTrusted, type TrustedPublisher } from '$lib/trust';
import { transition, type PersistEvent, type PersistState } from '$lib/settings/persist';
import type { PersistNoteState } from '$lib/components/shell/persist-note';
import type { TrustProvider } from '$lib/fabric';

const HEX_64 = /^[0-9a-f]{64}$/;

/** Drop non-hex and duplicate rows a stale or foreign tab may have written. */
function sanitize(keys: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of keys) {
		const key = raw.trim().toLowerCase();
		if (!HEX_64.test(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

export class TrustStore {
	/** Device-local overrides over the reviewed list. */
	overrides = $state<PersistedTrustOverrides>({ added: [], removed: [] });
	/** Bumps whenever the effective set changes; admission deriveds read it. */
	version = $state(0);
	/** Save truth for the Settings footer (persist-note's union). */
	persistState = $state<PersistNoteState>('idle');

	#machine: PersistState = { phase: 'idle' };
	#ready: Promise<void> | null = null;
	/** Serialized save chain; `flush()` is the test/boot barrier. */
	#pending: Promise<void> = Promise.resolve();

	/** One-shot hydrate behind the app's boot barrier. */
	ready(): Promise<void> {
		this.#ready ??= this.#hydrate();
		return this.#ready;
	}

	async #hydrate(): Promise<void> {
		await initPersistence();
		const persisted = await loadTrustOverrides();
		if (persisted !== null) {
			const removed = sanitize(persisted.removed);
			const removedSet = new Set(removed);
			// `removed` wins over `added`; a key in both is one intent, not two.
			const added = sanitize(persisted.added).filter((key) => !removedSet.has(key));
			this.overrides = { added, removed };
		}
		this.version++;
	}

	/** The effective list the app actually admits: base ∪ added \ removed.
	 * Derived once per override version — `isTrusted` runs per admitted event,
	 * and the old getter rebuilt the list (and its npub labels) on every read. */
	publishers = $derived.by(() =>
		effectiveTrusted(BUNDLED_TRUSTED.publishers, this.overrides.added, this.overrides.removed)
	);
	#keys = $derived(new Set(this.publishers.map((publisher) => publisher.pubkey)));

	isTrusted(pubkey: string): boolean {
		return this.#keys.has(pubkey.trim().toLowerCase());
	}

	/** Atomic commit for the list editor: validate every entry first, then
	 * derive the overrides against the reviewed base. A bad key mutates
	 * nothing, so the committed list stays the last good one. */
	async setTrusted(
		inputs: readonly string[]
	): Promise<{ ok: true } | { ok: false; message: string }> {
		const keys: string[] = [];
		for (const input of inputs) {
			const value = input.trim();
			if (value === '') continue;
			const parsed = parsePubkeyInput(value);
			if (!parsed.ok) return { ok: false, message: describePubkeyIssue(parsed.issue) };
			keys.push(parsed.pubkey);
		}
		const unique = [...new Set(keys)];
		const wanted = new Set(unique);
		const base = BUNDLED_TRUSTED.publishers.map((publisher) => publisher.pubkey);
		const nextAdded = unique.filter((key) => !base.includes(key));
		const nextRemoved = base.filter((key) => !wanted.has(key));
		const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
			a.length === b.length && a.every((key) => b.includes(key));
		if (
			sameSet(nextAdded, this.overrides.added) &&
			sameSet(nextRemoved, this.overrides.removed)
		) {
			return { ok: true };
		}
		this.overrides = { added: nextAdded, removed: nextRemoved };
		this.version++;
		await this.#enqueue();
		return { ok: true };
	}

	/** The branded predicate fabric's computeAdmission consumes. */
	get provider(): TrustProvider {
		return createTrustProvider((pubkey) => this.isTrusted(pubkey), this.version);
	}

	/** Resolves once every queued save settles. `add` stays synchronous for
	 * the blur handler; tests and the boot barrier await this instead. */
	flush(): Promise<void> {
		return this.#pending;
	}

	/** Parse, reject duplicates, and persist. Synchronous so the blur handler
	 * can paint the returned error before the save settles. */
    add(input: string): { ok: true } | { ok: false; message: string } {
        const parsed = parsePubkeyInput(input);
        if (!parsed.ok) return { ok: false, message: describePubkeyIssue(parsed.issue) };
        const key = parsed.pubkey;
        if (this.isTrusted(key)) return { ok: false, message: 'Already on your list.' };

		if (this.overrides.removed.includes(key)) {
			// Re-adding a removed bundled key is an undo, not a duplicate.
			this.overrides.removed = this.overrides.removed.filter((candidate) => candidate !== key);
		} else {
			this.overrides.added = [...this.overrides.added, key];
		}
		this.version++;
		void this.#enqueue();
		return { ok: true };
	}

	async remove(pubkey: string): Promise<void> {
		const key = pubkey.trim().toLowerCase();
		if (this.overrides.added.includes(key)) {
			this.overrides.added = this.overrides.added.filter((candidate) => candidate !== key);
		} else if (
			BUNDLED_TRUSTED.publishers.some((publisher) => publisher.pubkey === key) &&
			!this.overrides.removed.includes(key)
		) {
			this.overrides.removed = [...this.overrides.removed, key];
		} else {
			return;
		}
		this.version++;
		await this.#enqueue();
	}

	async reset(): Promise<void> {
		this.overrides = { added: [], removed: [] };
		this.version++;
		await this.#enqueue();
	}

	#enqueue(): Promise<void> {
		this.#pending = this.#pending.then(() => this.#persist());
		return this.#pending;
	}

	async #persist(): Promise<void> {
		const snapshot = (): PersistedTrustOverrides => ({
			added: [...this.overrides.added],
			removed: [...this.overrides.removed]
		});
		this.#fold({ type: 'save' });
		let outcome: SaveOutcome = await saveTrustOverrides(snapshot());
		this.#fold({ type: 'outcome', outcome });
		if (outcome === 'failed') {
			// One retry, same rule as the relay editor: the machine records the
			// debt, so a second failure stays failed.
			this.#fold({ type: 'save' });
			outcome = await saveTrustOverrides(snapshot());
			this.#fold({ type: 'outcome', outcome });
		}
	}

	#fold(event: PersistEvent): void {
		this.#machine = transition(this.#machine, event);
		this.persistState = this.#machine.phase;
	}
}

export const trust = new TrustStore();
