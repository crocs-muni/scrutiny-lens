// Cards, facets, and cohort line (issue #28, spec §2/§3): deterministic
// assembly from the admitted graph — one card per root product, warning-only
// status, i-tag chip values, deterministic fallback titles. Facets and the
// cohort line are computed here, never by AI (spec §2 rule 2).
//
// Interpretation fill (spec §2 rules 1/4/5): one zod-gated AI call per card
// batch; every failed item falls back to its skeleton marked not-interpreted;
// interpretations cache by (eventId, model) short-circuits repeats (spec §6).

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleCards,
  applyFacets,
  cohortLine,
  computeFacets,
  fillCards,
  type ProductCard,
} from "../src/lib/pipeline/cards";
import type { GraphView } from "$lib/fabric";
import {
  _closeForTests,
  clearAllLocalData,
  getInterpretation,
  initPersistence,
} from "$lib/db";
import type { NostrEvent } from "nostr-tools/core";

function hex(s: string, len = 64) {
  return s
    .padEnd(len, "0")
    .slice(0, len)
    .replaceAll(/[^0-9a-f]/g, "0");
}

/** Build a KV-format card-fill answer from {id, title, snippet} records. */
function fillKv(
  ...records: Array<{ id: string; title: string; snippet: string }>
): string {
  return records
    .map((r) => `id: ${r.id}\ntitle: ${r.title}\nsnippet: ${r.snippet}`)
    .join("\n\n");
}
function event(id: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: hex(id),
    sig: "cd".repeat(64),
    pubkey: "ef".repeat(32),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [
      ["t", "scrutiny-fabric"],
      ["t", "scrutiny-product"],
      ["i", "cve:CVE-2017-15361"],
    ],
    content: `content of ${id}`,
    ...overrides,
  };
}

function graphWith(
  productIds: string[],
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
  }> = [],
): GraphView {
  return {
    nodes: productIds.map((id) => ({
      id: hex(id),
      type: "product" as const,
      retracted: false,
      event: event(id),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
    })),
  };
}

// ── Assembly (spec §3: one card per root product) ──────────────────────────

describe("assembleCards (issue #28)", () => {
  it("returns one card per product root with identifier chips from i-tags", () => {
    const cards = assembleCards(graphWith(["prod-1", "prod-2"]), [
      event("prod-1"),
      event("prod-2"),
    ]);
    expect(cards.map((c) => c.id)).toEqual([hex("prod-1"), hex("prod-2")]);
    expect(cards[0].identifiers).toEqual(["cve:CVE-2017-15361"]);
    expect(cards.every((c) => c.interpreted === false)).toBe(true);
  });

  it("counts bound metadata via edges — deterministic, never AI (spec §2)", () => {
    const cards = assembleCards(
      graphWith(
        ["prod-1"],
        [
          {
            id: "bnd-1",
            source: hex("meta-1"),
            target: hex("prod-1"),
            label: "sbom",
          },
        ],
      ),
      [event("prod-1")],
    );
    expect(cards[0].boundMetadata).toBe(1);
  });

  it("counts patch updates via e-tag references to the product root", () => {
    const patch1 = event("patch-1", {
      tags: [
        ["t", "scrutiny-fabric"],
        ["t", "scrutiny-patch"],
        ["e", hex("prod-1")],
      ],
    });
    const patch2 = event("patch-2", {
      tags: [
        ["t", "scrutiny-fabric"],
        ["t", "scrutiny-patch"],
        ["e", hex("prod-1")],
      ],
    });
    const cards = assembleCards(graphWith(["prod-1"]), [patch1, patch2]);
    expect(cards[0].updates).toBe(2);
  });

  it("counts files: bound metadata whose content carries an http(s) link (spec §2 — deterministic)", () => {
    const prod = event("prod-1");
    const metaWithLink = event("meta-1", {
      content:
        "Maintenance report #1. PDF: https://commoncriteriaportal.org/maint.pdf",
    });
    const metaPlain = event("meta-2", {
      content: "keywords: EAL5, smart card, TOC",
    });
    const graph: GraphView = {
      nodes: [
        { id: prod.id, type: "product", retracted: false, event: prod },
        {
          id: metaWithLink.id,
          type: "metadata",
          retracted: false,
          event: metaWithLink,
        },
        {
          id: metaPlain.id,
          type: "metadata",
          retracted: false,
          event: metaPlain,
        },
      ],
      edges: [
        { id: "e1", source: metaWithLink.id, target: prod.id, label: "report" },
        { id: "e2", source: metaPlain.id, target: prod.id, label: "keywords" },
      ],
    };
    const cards = assembleCards(graph, [prod]);
    expect(cards[0].boundMetadata).toBe(2);
    expect(cards[0].files).toBe(1);
  });

  it("derives fallback title from first i-tag value, never from LLM output", () => {
    const cards = assembleCards(graphWith(["prod-1"]), [event("prod-1")]);
    expect(cards[0].title).toBe("cve:CVE-2017-15361");
  });
});

// ── Facets (spec §3: OR within, AND across, computed not described) ────────

describe("computeFacets + applyFacets (issue #28)", () => {
  function prod(id: string, ttags: Record<string, string[]>) {
    const ev = event(id, {
      tags: [
        ["t", "scrutiny-fabric"],
        ["t", "scrutiny-product"],
        ...Object.entries(ttags).flatMap(([prefix, values]) =>
          values.map((v) => ["i", `${prefix}:${v}`]),
        ),
      ],
    });
    return ev;
  }

  it("groups fetched tags by prefix from the pipeline, not the LLM", () => {
    const facets = computeFacets([
      prod("p1", { vendor: ["NXP"], scheme: ["common-criteria"] }),
      prod("p2", { vendor: ["Infineon"], scheme: ["common-criteria"] }),
    ]);
    const scheme = facets.find((g) => g.prefix === "scheme");
    const vendor = facets.find((g) => g.prefix === "vendor");
    expect(scheme?.values).toEqual([{ value: "common-criteria", count: 2 }]);
    expect(vendor?.values).toEqual(
      expect.arrayContaining([
        { value: "NXP", count: 1 },
        { value: "Infineon", count: 1 },
      ]),
    );
  });

  it("applyFacets: AND across prefixes, OR within one (spec §3)", () => {
    const events = [
      prod("p1", { vendor: ["NXP"], scheme: ["common-criteria"] }),
      prod("p2", { vendor: ["NXP"], scheme: ["fips"] }),
      prod("p3", { vendor: ["Infineon"], scheme: ["common-criteria"] }),
    ];
    // AND across prefixes
    let hit = applyFacets(events, {
      vendor: new Set(["NXP"]),
      scheme: new Set(["common-criteria"]),
    });
    expect(hit.map((e) => e.id)).toEqual([hex("p1")]);
    // OR within one prefix
    hit = applyFacets(events, { vendor: new Set(["NXP", "Infineon"]) });
    expect(hit.map((e) => e.id)).toEqual([hex("p1"), hex("p2"), hex("p3")]);
  });
});

describe("cohortLine (spec §3: by event type)", () => {
  it("counts products from cards and metadata from events", () => {
    const cards: ProductCard[] = [
      {
        id: "1",
        typeTag: "scrutiny-product",
        createdAt: 1700000000,
        pubkey: "aa",
        title: "t",
        identifiers: ["cve:CVE-1"],
        retracted: false,
        boundMetadata: 1,
        files: 0,
        updates: 1,
        contentStart: "",
        interpreted: false,
      },
      {
        id: "2",
        typeTag: "scrutiny-product",
        createdAt: 1700000000,
        pubkey: "bb",
        title: "t",
        identifiers: ["cve:CVE-2"],
        retracted: true,
        boundMetadata: 0,
        files: 0,
        updates: 0,
        contentStart: "",
        interpreted: false,
      },
    ];
    const line = cohortLine(cards, [
      event("a1"),
      event("a2", {
        tags: [
          ["t", "scrutiny-fabric"],
          ["t", "scrutiny-metadata"],
        ],
      }),
      event("a3", {
        tags: [
          ["t", "scrutiny-fabric"],
          ["t", "scrutiny-metadata"],
        ],
      }),
    ]);
    expect(line).toBe("2 products · 2 metadata");
  });

  it("is deterministic and zero-counts are shown, never hidden", () => {
    const cards = assembleCards(graphWith(["prod-1"]), [event("prod-1")]);
    expect(cohortLine(cards, [event("prod-1")])).toBe("1 product · 0 metadata");
  });
});

// ── Interpretation fill (spec §2 rules 1/4/5; cache at eventId+model) ──────

describe("fillCards (issue #28, spec §2)", () => {
  const PROVIDER = {
    baseUrl: "https://llm.example/v1",
    model: "test-model",
    apiKey: "sk-test-0273810714",
  };

  beforeEach(async () => {
    await initPersistence();
    await clearAllLocalData();
  });

  afterEach(() => {
    vi.useRealTimers();
    _closeForTests();
  });

  it("short-circuits on a cached interpretation without calling the LLM", async () => {
    // Prime the cache for the model.
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    const primed = { title: "cached title", snippet: "cached snippet" };
    const cacheKey = await import("$lib/db");
    await cacheKey.saveInterpretation(card.id, PROVIDER.model, "card", primed);

    const callLLM = vi.fn();
    const filled = await fillCards([card], { provider: PROVIDER, callLLM });
    expect(callLLM).not.toHaveBeenCalled();
    expect(filled[0].interpreted).toBe(true);
    expect(filled[0].title).toBe("cached title");
    expect(filled[0].snippet).toBe("cached snippet");
  });

  it("falls back to skeleton for every item when the zod gate fails", async () => {
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    const callLLM = vi.fn(async () => "not json at all");
    const filled = await fillCards([card], { provider: PROVIDER, callLLM });
    expect(callLLM).toHaveBeenCalledTimes(2); // one repair attempt
    expect(filled[0].interpreted).toBe(false);
    expect(filled[0].title).toBe("cve:CVE-2017-15361");
  });

  it("reports schema_failure (not unreachable) when the endpoint answers but junk is returned", async () => {
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    // The endpoint WAS reachable — it just answered with prose that never
    // conforms. The kind must say that, so the banner isn't "unreachable".
    const callLLM = async () => "Here is the filled card: sure, here you go.";
    const kinds: unknown[] = [];
    const filled = await fillCards([card], {
      provider: PROVIDER,
      callLLM,
      onFailure: (k) => kinds.push(k),
    });
    expect(filled[0].interpreted).toBe(false);
    expect(kinds).toContain("schema_failure");
    expect(kinds).not.toContain("unreachable");
  });

  it("reports unreachable when the endpoint does not answer", async () => {
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    const callLLM = async () => {
      throw new Error("ECONNREFUSED");
    };
    const kinds: unknown[] = [];
    await fillCards([card], {
      provider: PROVIDER,
      callLLM,
      onFailure: (k) => kinds.push(k),
    });
    expect(kinds).toEqual(["unreachable"]);
  });

  it("writes a validated interpretation into the cache keyed (eventId, model)", async () => {
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    const callLLM = async () =>
      fillKv({
        id: card.id,
        title: "ROCA-vulnerable Infineon chips",
        snippet:
          "Infineon TPM modules affected by the ROCA key-generation flaw.",
      });
    const filled = await fillCards([card], { provider: PROVIDER, callLLM });
    expect(filled[0].interpreted).toBe(true);
    const cached = await getInterpretation(card.id, PROVIDER.model);
    expect(cached?.bySurface.card).toEqual({
      title: "ROCA-vulnerable Infineon chips",
      snippet: "Infineon TPM modules affected by the ROCA key-generation flaw.",
    });
  });

  it("caps overlong fields at the schema bounds (titles ≤120, snippets ≤300)", async () => {
    const card = assembleCards(graphWith(["prod-1"]), [event("prod-1")])[0];
    const long = "x".repeat(400);
    const callLLM = async () =>
      fillKv({ id: card.id, title: long, snippet: long });
    const filled = await fillCards([card], { provider: PROVIDER, callLLM });
    expect(filled[0].title.length).toBeLessThanOrEqual(120);
    expect(filled[0].snippet?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it("salvages per-card: a truncated batch fills the good cards, leaves the truncated one raw (spec §2 rule 5)", async () => {
    const [a, b, c] = assembleCards(graphWith(["prod-1", "prod-2", "prod-3"]), [
      event("prod-1"),
      event("prod-2"),
      event("prod-3"),
    ]);
    // The model gets cut off mid-answer: two complete records, the third
    // missing its snippet. The old JSON gate would reject the whole batch;
    // KV salvage keeps the two that came through.
    const callLLM = async () =>
      [
        `id: ${a.id}\ntitle: T1\nsnippet: S1`,
        `id: ${b.id}\ntitle: T2\nsnippet: S2`,
        `id: ${c.id}\ntitle: T3`,
      ].join("\n\n");
    const kinds: unknown[] = [];
    const filled = await fillCards([a, b, c], {
      provider: PROVIDER,
      callLLM,
      onFailure: (k) => kinds.push(k),
    });
    expect(filled[0].interpreted).toBe(true);
    expect(filled[0].title).toBe("T1");
    expect(filled[1].interpreted).toBe(true);
    expect(filled[2].interpreted).toBe(false);
    // A partial salvage is a success, not a failure — no banner.
    expect(kinds).toEqual([]);
  });

  it("binds records only to requested ids: a foreign echoed id is dropped and its slot stays raw (spec §2 never-lie)", async () => {
    const [a, b, c] = assembleCards(graphWith(["prod-1", "prod-2", "prod-3"]), [
      event("prod-1"),
      event("prod-2"),
      event("prod-3"),
    ]);
    // The model mangles record 2: it describes card b but echoes an id that
    // was never requested. Nothing may borrow that text — b falls back to
    // its skeleton and nothing is cached under b's key.
    // TODO: (issue #59) A pure foreign echo was already inert under id-lookup
    // (drafts.get(b.id) can never hit "nope-foreign"), so this guard is
    // indistinguishable pre/post gate; the repeat/mangle case below is the
    // failing-first proof. Kept as the never-lie contract.
    const callLLM = async () =>
      fillKv(
        { id: a.id, title: "A-title", snippet: "A-snippet" },
        { id: "nope-foreign", title: "B-title", snippet: "B-snippet" },
        { id: c.id, title: "C-title", snippet: "C-snippet" },
      );
    const filled = await fillCards([a, b, c], { provider: PROVIDER, callLLM });
    expect(filled[0].interpreted).toBe(true);
    expect(filled[1].interpreted).toBe(false);
    expect(filled[1].title).toBe("cve:CVE-2017-15361"); // raw skeleton fallback
    expect(filled[2].interpreted).toBe(true);
    expect(filled[2].title).toBe("C-title");
    // Nothing persisted under the victim's (eventId, model) key.
    const cached = await getInterpretation(b.id, PROVIDER.model);
    expect(cached?.bySurface.card).toBeUndefined();
  });

  it("drops a record that repeats a sibling's id: the mangled card stays raw, the id owner keeps its own content (spec §2 never-lie)", async () => {
    const [a, b, c] = assembleCards(graphWith(["prod-1", "prod-2", "prod-3"]), [
      event("prod-1"),
      event("prod-2"),
      event("prod-3"),
    ]);
    // The model repeats card c's id for card b's slot, describing b's content.
    // It is ordered AFTER c's own record: a last-write map would overwrite c's
    // draft with b's text and cache the lie under c's key forever.
    const callLLM = async () =>
      fillKv(
        { id: a.id, title: "A-title", snippet: "A-snippet" },
        { id: c.id, title: "C-title", snippet: "C-snippet" },
        { id: c.id, title: "B-title", snippet: "B-snippet" },
      );
    const filled = await fillCards([a, b, c], { provider: PROVIDER, callLLM });
    expect(filled[1].interpreted).toBe(false);
    expect(filled[1].title).toBe("cve:CVE-2017-15361"); // b never adopts the mangle
    expect(filled[2].interpreted).toBe(true);
    expect(filled[2].title).toBe("C-title"); // c keeps its own record
    expect(filled[2].snippet).toBe("C-snippet");
    // Neither the mangled card nor the id owner absorbed a poisoned draft.
    const cachedB = await getInterpretation(b.id, PROVIDER.model);
    expect(cachedB?.bySurface.card).toBeUndefined();
    const cachedC = await getInterpretation(c.id, PROVIDER.model);
    expect(cachedC?.bySurface.card).toEqual({
      title: "C-title",
      snippet: "C-snippet",
    });
  });
});
