// Fill-lane pacing + per-card pending state (issue #59, spec §2 never-lie).
// A card mid-fill must read `interpreting…` — never identically to a card
// that will never be interpreted. Since issue #104 the four lanes fire at
// t0 together (pacing is the gateway's per-baseUrl window, not a UI-lane
// stagger) and a chunk whose arm kills a stalled pass is re-issued once on
// a fresh arm. These tests drive fillInChunks through the
// _fillInChunksForTests seam with a real fake-indexeddb cache so
// fillCards's persistence path runs for real.

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

describe("fillInChunks — lanes fire at t0; a stalled chunk re-issues once (issue #104)", () => {
	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
	});
	afterEach(() => {
		resetInvestigation();
		_closeForTests();
	});

	it("fires every lane at t0 — pacing is the gateway's job now, not the lane's", async () => {
		const fired: number[] = [];
		const callLLM: CallLLM = vi.fn(async (args) => {
			fired.push(performance.now());
			return kvAnswer(args);
		});
		// 12 cards / 3 per chunk → 4 lanes, one chunk each. The repealed
		// first-fire stagger (issue #59) spread these by laneIndex × 1.5s;
		// since #104 the gateway's per-baseUrl pacing window shapes what the
		// endpoint sees, so nothing here may spread the fires.
		const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		expect(fired.length).toBe(4);
		expect(Math.max(...fired) - Math.min(...fired)).toBeLessThan(500);
	});

	it("re-issues a stalled chunk once on a fresh arm when the run stays alive — the still-unfilled cards fill", async () => {
		let calls = 0;
		const callLLM: CallLLM = async (args) => {
			calls += 1;
			// The first pass hangs and its chunk arm kills it — simulated as
			// the abort-classified throw records rethrows out of fillCards.
			// The run stays ALIVE (no stop(), controller intact), so the
			// chunk's cards get exactly one fresh pass instead of settling
			// raw.
			if (calls === 1)
				throw new DOMException("The operation was aborted.", "AbortError");
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 3 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		expect(calls).toBe(2);
		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);
		expect(investigation.failed.size).toBe(0);
		expect(investigation.pending.size).toBe(0);
	});

	it("a partial-paint stall keeps the painted cards filled — the re-issue asks only for the remainder (issue #104)", async () => {
		// Review-of-#104 regression: onPaint painted card 0's record before
		// the chunk arm killed the pass. The stalled pass resolves with the
		// ORIGINAL raw cards; writing them back would revert the painted
		// card to raw (amber), and the re-issue would re-pay the LLM for a
		// card that already has its record. Painted truth is final.
		let calls = 0;
		const callLLM: CallLLM = async (args) => {
			calls += 1;
			if (calls === 1) throw new DOMException("The operation was aborted.", "AbortError");
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 3 }, (_, i) => card(`c-${i}`));
		const done = investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		// Simulate the onPaint that landed before the stall: merge card 0
		// as interpreted, exactly as the streamed view does.
		await vi.waitFor(() => expect(investigation.pending.size).toBe(3));
		const merged = investigation.cards.slice();
		merged[0] = { ...merged[0], title: "Painted Title", snippet: "Painted.", interpreted: true };
		investigation.cards = merged;
		await done;
		// All three settle filled; the painted card kept its own paint.
		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);
		expect(investigation.cards[0].title).toBe("Painted Title");
		expect(investigation.failed.size).toBe(0);
	});

	it("settles raw + amber when the re-issue stalls too — the honest degrade stands (spec §2)", async () => {
		let calls = 0;
		const callLLM: CallLLM = async () => {
			calls += 1;
			throw new DOMException("The operation was aborted.", "AbortError");
		};
		const cards = Array.from({ length: 3 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		// Exactly one re-issue — a twice-stalled chunk is never a hammer
		// loop.
		expect(calls).toBe(2);
		expect(investigation.cards.every((c) => !c.interpreted)).toBe(true);
		expect([...investigation.failed].sort()).toEqual(["c-0", "c-1", "c-2"]);
		expect(investigation.pending.size).toBe(0);
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

	it("a failed chunk's ids land in `failed` — the amber-tint claim (#82): claimed, never interpreted", async () => {
		const callLLM: CallLLM = async (args) => {
			const asked = JSON.parse(args.messages[0].content as string) as { id: string }[];
			if (asked.some((a) => a.id === "c-1")) throw new TypeError("network down");
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 6 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);

		// The failed set is the visible-retraction source: a card that was
		// claimed but settles uninterpreted must read amber, never silently
		// identical to a never-claimed one (spec §2). Interpreted chunk lays no claim.
		expect([...investigation.failed].sort()).toEqual(["c-0", "c-1", "c-2"]);
	});

	it("a later successful pass clears the id from `failed` — the retry's crossfade", async () => {
		const failing: CallLLM = async (args) => {
			const asked = JSON.parse(args.messages[0].content as string) as { id: string }[];
			if (asked.some((a) => a.id === "c-1")) throw new TypeError("network down");
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 6 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, failing);
		expect(investigation.failed.size).toBe(3);

		// Second pass, healthy endpoint (the two interpreted chunks now hit
		// the cache; only the failed chunk re-pays the LLM): the recovered
		// ids MUST drain — amber is a claimed-failure state, not a memory.
		await investigation._fillInChunksForTests(
			investigation.cards.slice(),
			PROVIDER,
			async (args) => kvAnswer(args),
		);
		expect(investigation.failed.size).toBe(0);
	});

	it("a deliberate abort never marks `failed` — killed ≠ failed (§8 abort; §2 never-lie)", async () => {
		let callCount = 0;
		const callLLM: CallLLM = async (args) => {
			callCount += 1;
			if (callCount === 1) investigation.stop();
			return kvAnswer(args);
		};
		const cards = Array.from({ length: 6 }, (_, i) => card(`c-${i}`));
		await investigation._fillInChunksForTests(cards, PROVIDER, callLLM);
		expect(investigation.failed.size).toBe(0);
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
