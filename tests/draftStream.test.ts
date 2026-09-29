// Draft stream (issue #109, spec §9 drafting voice): while a card's record
// is still arriving inside the open fill stream, its not-yet-gated prose
// lands in investigation.drafts — the dashed face's reduced-opacity
// overlay. The honesty contract these tests pin:
//   1. silently revoked (never persisted, never announced, no residue)
//      the moment any gate rejects the record — the card returns to raw;
//   2. display-clipped to exactly the same 120/300 limits the settle gate
//      enforces — the user never sees more text than can survive the gate,
//      so nothing shown gets visibly taken back;
//   3. id-first gating — a foreign/mangled id never paints a draft at all
//      (the same affinity gate as the settle pass, just earlier);
//   4. a settled card owns its text on the live face — its draft entry is
//      removed the moment onPaint fires;
//   5. aria contract — no live-region input reads drafts: fillStats (the
//      #108 announcement feed) counts SETTLED records only, so a draft in
//      flight never moves it. (The ResultCard aria-hidden DOM markup is
//      browser-verified; no component harness exists in this suite — all
//      tests here are .ts.)
//
// Deterministic synchronization WITHOUT timers: the generator resolving
// `consumed` after a yield proves the pipeline synchronously finished
// processing that delta (streamRecords' for-await calls next() only after
// its per-delta onDraft hook ran), and `open` holds the trailing block
// un-completed for exactly the mid-flight assertion window — the same
// "gate the stream, never sleep" pattern as cards.test.ts's streamed
// suite's openGate.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	investigation,
	resetInvestigation,
} from "../src/lib/investigation.svelte";
import { _closeForTests, clearAllLocalData, initPersistence } from "$lib/db";
import type { CallLLM } from "../src/lib/ai/output";
import type { StreamLLM } from "../src/lib/ai/records";
import type { ProductCard } from "../src/lib/pipeline/cards";
import { clip } from "$lib/text";

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

/** Batch seams must stay silent in these tests — the stream arm owns them. */
const noBatch: CallLLM = () => {
	throw new Error("batch callLLM must not fire: the stream seam is armed");
};

/** A stream fake whose consumption points are observable: `consumed`
 * resolves once the pipeline has synchronously processed the FIRST yield;
 * the generator then parks on the gate until the test's `open()` — the
 * mid-flight assertion window. The closure deliberately survives the
 * re-prompt: streamRecords calls the fake a second time when nothing
 * gated, and the replay yields the same deterministic bytes. */
function gatedStream(
	before: string,
	after: string | null,
): { streamLLM: StreamLLM; consumed: Promise<void>; open: () => void } {
	const saw = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const streamLLM: StreamLLM = async function* () {
		yield before;
		saw.resolve();
		await gate.promise;
		if (after !== null) yield after;
	};
	return { streamLLM, consumed: saw.promise, open: gate.resolve };
}

describe("draft stream (issue #109, spec §9 drafting voice)", () => {
	beforeEach(async () => {
		await initPersistence();
		await clearAllLocalData();
		resetInvestigation();
	});

	afterEach(() => {
		_closeForTests();
	});

	it("vanish-on-reject: a draft whose block never gates leaves no residue — card stays raw", async () => {
		const a = card("draft-reject");
		// The trailing block holds an id + a PARTIAL title — no snippet, no
		// blank-line boundary. It can never survive the zod gate.
		const { streamLLM, consumed, open } = gatedStream(`id: ${a.id}\ntitle: Partial Ti`, null);
		const promised = investigation._fillInChunksForTests([a], PROVIDER, noBatch, undefined, {
			stream: streamLLM,
		});
		// Mid-flight: the not-yet-gated prose IS on the draft surface.
		await consumed;
		expect(investigation.drafts.get(a.id)).toEqual({ title: "Partial Ti", snippet: "" });
		open();
		await promised;
		// The record died at the gate (no snippet → schema_failure after the
		// one re-prompt): the draft is silently revoked — no entry, no
		// partial residue on the card, and the card reads raw. The pass
		// FAILED, so amber applies (the settle's own honest vocabulary).
		expect(investigation.drafts.size).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(false);
		expect(investigation.cards[0]?.title).toBe(a.title);
		expect(investigation.failed.has(a.id)).toBe(true);
	});

	it("display-clip: streaming draft text is held at exactly the gate's 120/300 clip", async () => {
		const a = card("draft-clip");
		const longTitle = "T".repeat(130);
		const longSnippet = "S".repeat(320);
		const { streamLLM, consumed, open } = gatedStream(
			`id: ${a.id}\ntitle: ${longTitle}\nsnippet: ${longSnippet}`,
			"\n\n", // the gate then rejects (title >120) and revokes the draft
		);
		const promised = investigation._fillInChunksForTests([a], PROVIDER, noBatch, undefined, {
			stream: streamLLM,
		});
		await consumed;
		// Exactly the same strings the settle path's clip() would produce —
		// never more text than can survive the gate.
		expect(investigation.drafts.get(a.id)).toEqual({
			title: clip(longTitle, 120),
			snippet: clip(longSnippet, 300),
		});
		open();
		await promised;
		// The boundary completing revoked the draft even before the settle
		// gate's verdict landed — that is the silent revoke.
		expect(investigation.drafts.size).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(false);
	});

	it("id-mismatch: a foreign id never paints a draft, and its completed block paints nothing", async () => {
		const a = card("draft-affinity");
		// A well-formed record — but its id was never requested for this
		// chunk (the affinity gate, earlier and at settle).
		const { streamLLM, consumed, open } = gatedStream(
			`id: foreign-${a.id}\ntitle: Foreign Title\nsnippet: Foreign snippet`,
			"\n\n", // the block completes and STILL paints nothing
		);
		const promised = investigation._fillInChunksForTests([a], PROVIDER, noBatch, undefined, {
			stream: streamLLM,
		});
		// The first delta was fully processed — the affinity pre-check
		// blocked the write entirely, so the draft surface stays empty.
		await consumed;
		expect(investigation.drafts.size).toBe(0);
		open();
		await promised;
		// The completed foreign record painted no card either (the same
		// gate at settle): the card is raw and no text leaked.
		expect(investigation.drafts.size).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(false);
		expect(investigation.cards[0]?.title).toBe(a.title);
		expect(investigation.fillStats.interpreted).toBe(0);
	});

	it("settle clears: a drafted card that gates removes its draft — the live face owns the text", async () => {
		const a = card("draft-settle");
		const { streamLLM, consumed, open } = gatedStream(
			`id: ${a.id}\ntitle: Part`,
			// The same line continues, the record completes, the boundary
			// arrives — the block gates, onPaint fires, the draft goes.
			`ial Title\nsnippet: Full snippet now\n\n`,
		);
		const promised = investigation._fillInChunksForTests([a], PROVIDER, noBatch, undefined, {
			stream: streamLLM,
		});
		await consumed;
		expect(investigation.drafts.get(a.id)).toEqual({ title: "Part", snippet: "" });
		open();
		await promised;
		expect(investigation.drafts.size).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(true);
		expect(investigation.cards[0]?.title).toBe("Partial Title");
		expect(investigation.cards[0]?.snippet).toBe("Full snippet now");
	});

	it("aria contract: a draft in flight never moves the settled-record announcement feed", async () => {
		const a = card("draft-aria");
		const { streamLLM, consumed, open } = gatedStream(
			`id: ${a.id}\ntitle: Streaming title\nsnippet: Streaming snip`,
			`pet\n\n`,
		);
		const promised = investigation._fillInChunksForTests([a], PROVIDER, noBatch, undefined, {
			stream: streamLLM,
		});
		await consumed;
		// Shape: a draft entry is exactly clipped title + snippet strings —
		// no raw stream text, no prose beyond the two slots the dashed face
		// overlays (both rendered aria-hidden in ResultCard — browser pass).
		expect(Object.keys(investigation.drafts.get(a.id) ?? {}).sort()).toEqual([
			"snippet",
			"title",
		]);
		// fillStats is the #108 live region's only input: it counts SETTLED
		// records, so the in-flight draft leaves it untouched — no
		// announcement path can speak pre-gate text.
		expect(investigation.fillStats.interpreted).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(false);
		open();
		await promised;
		expect(investigation.drafts.size).toBe(0);
		expect(investigation.cards[0]?.interpreted).toBe(true);
		expect(investigation.cards[0]?.snippet).toBe("Streaming snippet");
	});
});
