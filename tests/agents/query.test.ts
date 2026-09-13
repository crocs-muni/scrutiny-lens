// Query translation (issue #28, spec §1/§3): identifiers route DIRECTLY to
// tag searches, never through AI; prose goes through one zod-gated AI call
// (≤3 searches, prefixes open per IR-4); no key / AI-down → one free-text
// search, never nothing. Decision clauses never become extra searches.

import { describe, expect, it } from "vitest";
import type { CallLLM, CallLLMArgs } from "$lib/ai/output";
import {
  GUIDED_PREFIXES,
  detectIdentifiers,
  translateQuestion,
  type SearchRequest,
} from "$lib/ai/agents/query";

const PROVIDER = {
  baseUrl: "https://llm.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

/** Fake LLM returning the nth queued text per call (last one repeats). */
function fakeLLM(...texts: string[]): { call: CallLLM; calls: CallLLMArgs[] } {
  const calls: CallLLMArgs[] = [];
  const call: CallLLM = async (args) => {
    calls.push(args);
    return texts[Math.min(calls.length - 1, texts.length - 1)];
  };
  return { call, calls };
}

function throwing(message: string): CallLLM {
  return async () => {
    throw new Error(message);
  };
}

/** Build a KV-format model answer from {kind, value} pairs. */
function kv(...pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `kind: ${k}\nvalue: ${v}`).join("\n\n");
}

describe("detectIdentifiers (spec §1: route directly, never through AI)", () => {
  it("picks up a bare CVE id", () => {
    expect(detectIdentifiers("ROCA in CVE-2017-15361 chips")).toEqual([
      "cve:CVE-2017-15361",
    ]);
  });

  it("picks up GHSA and purl forms", () => {
    expect(detectIdentifiers("GHSA-jfh8-c2jp-5v3q exposure")).toEqual([
      "ghsa:GHSA-jfh8-c2jp-5v3q",
    ]);
    expect(detectIdentifiers("pkg:npm/lodash@4.17.20")).toEqual([
      "purl:pkg:npm/lodash@4.17.20",
    ]);
  });

  it("passes arbitrary typed prefix:value through opaquely (spec §3, IR-4)", () => {
    expect(detectIdentifiers("xyz:123 what")).toEqual(["xyz:123"]);
  });

  it("finds nothing in plain prose", () => {
    expect(detectIdentifiers("is the NXP JCOP4 still certified?")).toEqual([]);
  });

  it("documents the guided prefix list from spec §3", () => {
    expect(GUIDED_PREFIXES).toContain("cve");
    expect(GUIDED_PREFIXES).toContain("cc-cert-id");
  });
});

describe("translateQuestion — identifier-only questions skip AI entirely", () => {
  it("a bare identifier produces one tag search, zero model calls", async () => {
    const { call, calls } = fakeLLM("[]");
    const res = await translateQuestion({
      question: "CVE-2017-15361",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls).toHaveLength(0);
    expect(res.result.searches).toEqual([
      {
        kind: "tag",
        value: "cve:CVE-2017-15361",
        source: "identifier",
      } satisfies SearchRequest,
    ]);
  });

  it("typed prefix:value (unknown prefix) is also AI-free (IR-4)", async () => {
    const { call, calls } = fakeLLM("[]");
    const res = await translateQuestion({
      question: "pp:ANSSI-CC-2024/55",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(calls).toHaveLength(0);
    expect(res.ok && res.result.searches).toEqual([
      { kind: "tag", value: "pp:ANSSI-CC-2024/55", source: "identifier" },
    ]);
  });
});

describe("translateQuestion — prose goes through one gated call (≤3)", () => {
  it("pure prose: one AI call, accepted tag + text searches", async () => {
    const { call, calls } = fakeLLM(
      kv(["text", "NXP JCOP4 certification"], ["tag", "vendor:NXP"]),
    );
    const res = await translateQuestion({
      question: "is the NXP JCOP4 still certified?",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(calls).toHaveLength(1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.searches).toEqual([
      { kind: "text", value: "NXP JCOP4 certification", source: "ai" },
      { kind: "tag", value: "vendor:NXP", source: "ai" },
    ]);
  });

  it("the AI portion is capped at 3; identifiers keep their route (spec §3)", async () => {
    // The model disobeys the ≤3 bound (emits 4); the KV salvage keeps the
    // first 3 instead of the old all-or-nothing JSON reject.
    const { call } = fakeLLM(
      kv(["text", "a"], ["text", "b"], ["text", "c"], ["text", "d"]),
    );
    const res = await translateQuestion({
      question: "CVE-2017-15361 vulnerability details",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The identifier keeps its deterministic route (never dropped, spec §1).
    expect(res.result.searches[0]).toEqual({
      kind: "tag",
      value: "cve:CVE-2017-15361",
      source: "identifier",
    });
    // 4 emitted → 3 kept (a, b, c); the over-limit 4th is dropped.
    expect(res.result.searches.filter((s) => s.source === "ai")).toHaveLength(
      3,
    );
  });

  it("an unknown prefix from the model is accepted (open prefix list)", async () => {
    const { call } = fakeLLM(kv(["tag", "weirdprefix:abc"]));
    const res = await translateQuestion({
      question: "try weirdprefix:abc",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok && res.result.searches).toContainEqual({
      kind: "tag",
      value: "weirdprefix:abc",
      source: "ai",
    });
  });

  it('malformed model entries are dropped (no "gotcha" fabricated fallback)', async () => {
    const { call } = fakeLLM(
      ["kind: tag\nvalue: not a tag", kv(["tag", "cve:x"])].join("\n\n"),
    );
    const res = await translateQuestion({
      question: "inject malformed",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok && res.result.searches).toEqual([
      { kind: "tag", value: "cve:x", source: "ai" },
    ]);
  });

  it("a mixed bare-identifier + prose question keeps BOTH searches (spec §1/§3, review R2)", async () => {
    const { call, calls } = fakeLLM(kv(["text", "Infineon chips"]));
    const res = await translateQuestion({
      question: "CVE-2017-15361 in Infineon chips",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(calls).toHaveLength(1); // prose part is translated, not dropped
    expect(res.ok && res.result.searches).toEqual([
      { kind: "tag", value: "cve:CVE-2017-15361", source: "identifier" },
      { kind: "text", value: "Infineon chips", source: "ai" },
    ]);
  });
});

describe("translateQuestion — tolerant KV parsing of endpoint answers", () => {
  it("tolerates prose before and after the records", async () => {
    const { call } = fakeLLM(
      "Here are the searches I would run:\n\n" +
        kv(["text", "ROCA smartcard"]) +
        "\n\nThat should cover it.",
    );
    const res = await translateQuestion({
      question: "ROCA chips",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok && res.result.searches).toEqual([
      { kind: "text", value: "ROCA smartcard", source: "ai" },
    ]);
  });

  it("tolerates extra blank lines between and after records", async () => {
    const { call } = fakeLLM(
      kv(
        ["text", "ROCA"],
        ["tag", "cve:CVE-2017-15361"],
        ["text", "JIT"],
      ).replace(/\n\n/g, "\n\n\n") + "\n\n",
    );
    const res = await translateQuestion({
      question: "ROCA chips",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.searches).toEqual([
      { kind: "text", value: "ROCA", source: "ai" },
      { kind: "tag", value: "cve:CVE-2017-15361", source: "ai" },
      { kind: "text", value: "JIT", source: "ai" },
    ]);
  });
});

describe("translateQuestion — deterministic fallbacks (spec §2 rule 5 spirit)", () => {
  it("schema failure retries once, then degrades to one free-text search", async () => {
    const { call, calls } = fakeLLM("not json at all", "also not json");
    const res = await translateQuestion({
      question: "ROCA chips",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(calls).toHaveLength(2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.searches).toEqual([
      { kind: "text", value: "ROCA chips", source: "fallback" },
    ]);
  });

  it("AI unreachable → one free-text search, not an error", async () => {
    const res = await translateQuestion({
      question: "ROCA chips",
      provider: PROVIDER,
      callLLM: throwing("ECONNREFUSED"),
    });
    expect(res.ok && res.result.searches).toEqual([
      { kind: "text", value: "ROCA chips", source: "fallback" },
    ]);
  });

  it("no provider configured → question becomes one free-text search, no call", async () => {
    const { call, calls } = fakeLLM("[]");
    const res = await translateQuestion({
      question: "ROCA chips",
      provider: undefined,
      callLLM: call,
    });
    expect(calls).toHaveLength(0);
    expect(res.ok && res.result.searches).toEqual([
      { kind: "text", value: "ROCA chips", source: "fallback" },
    ]);
  });

  it("an empty prose remainder after identifier extraction is not searched again", async () => {
    const { calls, call } = fakeLLM("[]");
    const res = await translateQuestion({
      question: "CVE-2017-15361",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(calls).toHaveLength(0);
    expect(res.ok && res.result.searches).toEqual([
      { kind: "tag", value: "cve:CVE-2017-15361", source: "identifier" },
    ]);
  });
});
