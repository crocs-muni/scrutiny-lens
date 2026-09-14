// Session-settle traversal (lens #68): the settle pass fires after
// `this.result = session` in start(). These tests pin the wiring contract
// vitest CAN see — refreshSessionContext operates on `this.result`.
//
// WHY THAT MATTERS (the bug this file guards): in the browser, Svelte 5
// `$state` proxies `session` on assignment to `this.result`, so start()'s
// raw `session` local and the stored field are DIFFERENT objects. The old
// signature `refreshSessionContext(session)` handed admitContext the raw
// object, whose identity guard (`this.result !== session`) then failed for
// the CURRENT run — every settle pass silently dropped its fetched context
// in production while node-side tests passed (runes compile to plain
// fields without the svelte plugin; see resetSettings's comment). The
// parameterless signature reading this.result is the regression guard;
// the full-fidelity check is the browser acceptance walk on lens #68.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/core";
import {
	investigation,
	resetInvestigation,
} from "../src/lib/investigation.svelte";
import { _closeForTests, clearAllLocalData, initPersistence } from "$lib/db";
import {
	createTransport,
	type CountResult,
	type FetchResult,
	type FetchRoute,
	type FetchSlice,
	type RelayCapability,
	type RelayStatus,
	type Transport,
} from "$lib/net/transport";

vi.mock("$lib/net/transport", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/net/transport")>();
	return {
		...actual,
		createTransport: vi.fn(),
	};
});

/** Genuinely-signed synthetic event (same pattern as traversal.test.ts):
 * real key, real NIP-01 id — the admission gates require both. */
function forge(kind: number, tags: string[][], content = ""): NostrEvent {
	return finalizeEvent({ kind, created_at: 1_780_000_000, tags, content }, generateSecretKey());
}

function product(): NostrEvent {
	return forge(1, [
		["t", "scrutiny-fabric"],
		["t", "scrutiny-v0.8.1"],
		["t", "scrutiny-product"],
	]);
}

/** Binding whose referenced metadata arrives on the round-2 endpoint leg. */
function bindingOn(productId: string, metaId: string): NostrEvent {
	return forge(1, [
		["t", "scrutiny-fabric"],
		["t", "scrutiny-v0.8.1"],
		["t", "scrutiny-binding"],
		["e", productId, "", "root", ""],
		["e", metaId, "", "link", ""],
	]);
}

function metadata(): NostrEvent {
	return forge(1, [
		["t", "scrutiny-fabric"],
		["t", "scrutiny-v0.8.1"],
		["t", "scrutiny-metadata"],
	]);
}

/** Stub transport answering per route LABEL across however many rounds
 * fetchSessionContext runs (pattern borrowed from traversal.test.ts). */
class StubTransport implements Transport {
	readonly routes: FetchRoute[][] = [];
	constructor(private readonly answers: Map<string, NostrEvent[]>) {}
	urls: string[] = ["ws://relay.test"];
	async fetchRouted(
		routes: FetchRoute[],
		onSlice: (s: FetchSlice) => void,
	): Promise<FetchResult> {
		this.routes.push(routes);
		for (const route of routes) {
			const answer = this.answers.get(route.label) ?? [];
			const status: RelayStatus = { url: route.urls[0] ?? "ws://relay.test", status: "ok", count: answer.length };
			onSlice({ url: status.url, events: answer, status, route: route.label });
		}
		const flat = routes.flatMap((r) => this.answers.get(r.label) ?? []);
		const seen = new Set<string>();
		const events: NostrEvent[] = [];
		for (const e of flat) {
			if (seen.has(e.id)) continue;
			seen.add(e.id);
			events.push(e);
		}
		return { events, relays: [] };
	}
	fetch(_filters: unknown[]): Promise<FetchResult> {
		return Promise.reject(new Error("unused"));
	}
	fetchProgressive(_filters: unknown[], _onSlice: (s: FetchSlice) => void): Promise<FetchResult> {
		return Promise.reject(new Error("unused"));
	}
	count(_filters: unknown[]): Promise<CountResult> {
		return Promise.reject(new Error("unused"));
	}
	capability(_url: string): Promise<RelayCapability> {
		return Promise.resolve("unknown");
	}
	capabilitySync(_url: string): RelayCapability {
		return "unknown";
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
}

describe("refreshSessionContext — settle wiring (lens #68)", () => {
	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
	});
	afterEach(() => {
		resetInvestigation();
		vi.clearAllMocks();
		_closeForTests();
	});

	it("settles through this.result: traversal context lands in the STORED session", async () => {
		const subject = product();
		const meta = metadata();
		const binding = bindingOn(subject.id, meta.id);
		const transport = new StubTransport(
			new Map([
				["traversal:bindings", [binding]],
				["traversal:bindings:endpoints", [meta]],
			]),
		);
		vi.mocked(createTransport).mockReturnValue(transport);

		// Simulate start()'s tail: raw session assembled first, THEN stored —
		// exactly the shape where a caller-held raw object diverges from the
		// $state proxy in the browser.
		const session = {
			searches: [],
			admitted: [subject],
			invalidSkipped: 0,
			notices: [],
			relays: [],
		};
		investigation.result = session;

		await investigation.refreshSessionContext();

		// Both traversal rounds fired…
		expect(transport.routes.length).toBeGreaterThanOrEqual(2);
		// …and the fetched binding + its endpoint landed in the SAME session
		// object the store holds — the exact behavior the raw-vs-proxy guard
		// bug destroyed in the browser (silent no-op).
		const ids = investigation.result?.admitted.map((e) => e.id);
		expect(ids).toContain(binding.id);
		expect(ids).toContain(meta.id);
	});

	it("a null result settles to nothing (no throw, no transport)", async () => {
		investigation.result = null;
		await expect(investigation.refreshSessionContext()).resolves.toBeUndefined();
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("an empty admitted set skips the relay round entirely", async () => {
		const transport = new StubTransport(new Map());
		vi.mocked(createTransport).mockReturnValue(transport);
		investigation.result = {
			searches: [],
			admitted: [],
			invalidSkipped: 0,
			notices: [],
			relays: [],
		};
		await investigation.refreshSessionContext();
		expect(transport.routes).toEqual([]);
	});
});
