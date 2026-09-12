// Fill-lane pacing + per-card pending state (issue #59, spec §2 never-lie).
// A card mid-fill must read `interpreting…` — never identically to a card
// that will never be interpreted — and the four lanes must stagger their
// FIRST fires so the endpoint never sees 4 simultaneous requests. These
// tests drive fillInChunks through the _fillInChunksForTests seam with a
// real fake-indexeddb cache so fillCards's persistence path runs for real.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	investigation,
	resetInvestigation,
} from "../src/lib/investigation.svelte";
import { _closeForTests, clearAllLocalData, initPersistence } from "$lib/db";
import type { CallLLM } from "../src/lib/ai/output";
import type { ProductCard } from "../src/lib/pipeline/cards";

const PROVIDER = {
	baseUrl: "https://llm.example/v1",
	model: "test-model",
	apiKey: "sk-test-0273810714",
};

function card(id: string): ProductCard {
	return {
		id,
		typeTag: "scrutiny-product",
		createdAt: 1_700_000_000,
		pubkey: "ab".repeat(4),
		title: id,
		identifiers: [`cve:CVE-${id}`],
		retracted: false,
		boundMetadata: 0,
		files: 0,
		updates: 0,
		contentStart: `content ${id}`,
		interpreted: false,
	};
}

/** One KV record per id the chunk asked about (same shape as cards.test). */
function fillKv(...records: Array<{ id: string; title: string; snippet: string }>): string {
	return records
		.map((r) => `id: ${r.id}\ntitle: ${r.title}\nsnippet: ${r.snippet}`)
		.join("\n\n");
}

/** Answers whatever ids the prompt requested, tagArray = ids asked. */
function kvAnswer(callLLMArgs: Parameters<CallLLM>[0]): string {
	const asked = JSON.parse(callLLMArgs.messages[0].content as string) as {
		id: string;
	}[];
	return fillKv(...asked.map((a) => ({ id: a.id, title: `T-${a.id}`, snippet: `S-${a.id}` })));
}

describe("fillInChunks — lane stagger (issue #59)", () => {
	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
	});
	afterEach(() => {
		resetInvestigation();
		_closeForTests();
	});

	it("staggers each lane's first fire by laneIndex × laneStaggerMs", async () => {
		const fired: number[] = [];
		const callLLM: CallLLM = vi.fn(async (args) => {
			fired.push(performance.now());
			return kvAnswer(args);
		});
		const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
		const STAGGER = 30;
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM, STAGGER);

		// 12 cards / 3 per chunk → 4 lanes fire once each. Lane 0 fires at
		// t0 and lane 3 no earlier than 3× the stagger later — generous
		// tolerance: the assertion exists to catch the all-at-once burst
		// (which lands all four fires within ~15ms, not ±75ms).
		expect(fired.length).toBe(4);
		expect(fired[3] - fired[0]).toBeGreaterThanOrEqual(STAGGER * 3 - 15);
	});

	it("a lane's later claims are NOT re-staggered (pacing win only on first fire)", async () => {
		const fired: number[] = [];
		const callLLM: CallLLM = vi.fn(async (args) => {
			fired.push(performance.now());
			return kvAnswer(args);
		});
		// 15 cards / 3 per chunk = 5 chunks over 4 lanes — lane 0 re-claims
		// the 5th chunk immediately after its first settles, long before
		// lane 3's stagger elapses. If re-claims ate a stagger pause, the
		// second invocation would trail the first by ≥ STAGGER.
		const cards = Array.from({ length: 15 }, (_, i) => card(`c${i}`));
		const STAGGER = 150;
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM, STAGGER);
		expect(fired.length).toBe(5);
		expect(fired[1] - fired[0]).toBeLessThan(STAGGER);
	});
});

describe("fillInChunks — per-card pending lifecycle (issue #59)", () => {
	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
	});
	afterEach(() => {
		resetInvestigation();
		_closeForTests();
	});

	it("pending → interpreted: claimed ids are pending mid-flight, merge clears them", async () => {
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		let calls = 0;
		const callLLM: CallLLM = async (args) => {
			calls += 1;
			await gate;
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
		const done = investigation._fillInChunksForTests(cards, PROVIDER, callLLM);

		// Once all four lanes have invoked the LLM, every chunk is claimed
		// but unresolved — the NEVER-LIE gap the issue names: while the LLM
		// is mid-flight these 12 ids must read `pending`.
		await vi.waitFor(() => expect(calls).toBe(4));
		expect(investigation.pending.size).toBe(12);
		expect(cards.some((c) => c.interpreted)).toBe(false);

		resolve();
		await done;
		expect(investigation.pending.size).toBe(0);
		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);
		expect(investigation.fillStats).toEqual({ interpreted: 12, total: 12 });
	});

	it("pending → raw: a chunk that fails settles rule-5 and its ids leave pending", async () => {
		const callLLM: CallLLM = async (args) => {
			const asked = JSON.parse(args.messages[0].content as string) as { id: string }[];
			// Chunk 0 (c-0..c-2) always fails — a callLLM throw surfaces as a
			// generateRecords kind, the lane settles the chunk as rule-5 raw
			// and keeps going (spec §4).
			if (asked.some((a) => a.id === "c-1")) throw new TypeError("network down");
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 6 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);

		expect(investigation.pending.size).toBe(0);
		const raw = investigation.cards.filter((c) => !c.interpreted).map((c) => c.id);
		expect(raw.sort()).toEqual(["c-0", "c-1", "c-2"]);
		const interpreted = investigation.cards.filter((c) => c.interpreted).map((c) => c.id);
		expect(interpreted.sort()).toEqual(["c-3", "c-4", "c-5"]);
		expect(investigation.fillStats).toEqual({ interpreted: 3, total: 6 });
	});

	it("an aborted run never leaks ids — pending drains on the abort path", async () => {
		let callCount = 0;
		const callLLM: CallLLM = async (args) => {
			callCount += 1;
			// Abort the seam's own controller mid-flight (spec §8 abort
			// lifecycle): claimed ids must still drain at lane settle, or a
			// killed run would pin `interpreting…` forever.
			if (callCount === 1) investigation.stop();
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 6 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		expect(investigation.pending.size).toBe(0);
	});
});
