// The AI transport contract (issue #52): generateRecords resolves the
// provider, forwards it + the abortSignal to the transport, classifies
// transport failures honestly (unreachable / timeout / browser_blocked /
// rate_limited — never conflating a browser CORS block with a 5xx, or a
// throttling endpoint with a dead one, spec §2), propagates aborts, and
// does not retry when the first call fails at transport level.

import { afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { generateRecords } from "$lib/ai/records";
import type { CallLLM, CallLLMArgs } from "$lib/ai/output";

const Rec = z.object({ id: z.string().min(1) });
const messages = [{ role: "user" as const, content: "hi" }];

afterEach(() => vi.unstubAllGlobals());

function fakeLLM(responses: string[]): { call: CallLLM; calls: CallLLMArgs[] } {
  const calls: CallLLMArgs[] = [];
  const call: CallLLM = async (args) => {
    calls.push(args);
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra call");
    return next;
  };
  return { call, calls };
}

describe("generateRecords transport", () => {
  const provider = { baseUrl: "https://x/v1", model: "m", apiKey: "k" };

  it("returns the parsed record on a clean KV response", async () => {
    const { call, calls } = fakeLLM(["id: a"]);
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toEqual([{ id: "a" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].temperature).toBe(0.2);
  });

  it("degrades to schema_failure after exactly one re-prompt on unrecognizable output", async () => {
    const { call, calls } = fakeLLM([
      "not a record at all",
      "still not a record",
    ]);
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("schema_failure");
    expect(calls).toHaveLength(2); // initial + exactly one re-prompt
  });

  it("returns a degraded no_key result when no provider is given", async () => {
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("no_key");
  });

  it("returns invalid_request when the provider override is malformed", async () => {
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider: { baseUrl: "ftp://x", model: "m", apiKey: "k" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("invalid_request");
  });

  it("forwards the provider override to the transport", async () => {
    const { call, calls } = fakeLLM(["id: a"]);
    await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider: {
        baseUrl: "https://byok.example/v1",
        model: "gpt-x",
        apiKey: "sk-byok",
      },
      callLLM: call,
    });
    expect(calls[0].provider).toEqual({
      name: "override",
      baseUrl: "https://byok.example/v1",
      model: "gpt-x",
      apiKey: "sk-byok",
    });
  });

  it("forwards the abortSignal to the transport", async () => {
    const signal = new AbortController().signal;
    const { call, calls } = fakeLLM(["id: a"]);
    await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
      abortSignal: signal,
    });
    expect(calls[0].signal).toBe(signal);
  });

  it("propagates an abort as a rejection (caller cancellation)", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const call: CallLLM = async (args) => {
      if (args.signal?.aborted) throw new Error("The operation was aborted.");
      return "id: a";
    };
    await expect(
      generateRecords({
        schema: Rec,
        knownKeys: ["id"],
        messages: [],
        provider,
        callLLM: call,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("maps transport HTTP failures to a degraded unreachable result", async () => {
    const call: CallLLM = async () => {
      const err = new Error("upstream 500") as Error & { statusCode?: number };
      err.statusCode = 500;
      throw err;
    };
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unreachable");
  });

  it("maps a 429 statusCode to rate_limited, distinct from unreachable, with a deterministic message", async () => {
    // A throttled BYOK endpoint ANSWERS 429 — reachable-but-slow, which is
    // not the same truth as a dead endpoint (spec §2 never-lie). The SDK's
    // APICallError carries statusCode; after its retries are exhausted the
    // surfaced error keeps that shape.
    const call: CallLLM = async () => {
      const err = new Error("upstream 429 body") as Error & {
        statusCode?: number;
      };
      err.statusCode = 429;
      throw err;
    };
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("rate_limited");
      // Deterministic and endpoint-independent — the body ("upstream 429
      // body") is never echoed (spec §2/ADR-018); <host> is URL-derived.
      expect(r.message).toBe("429 Rate limit x");
    }
  });

  it("maps a browser-blocked fetch (TypeError, no status) to browser_blocked, not unreachable", async () => {
    // CORS preflight / mixed-content blocks reject fetch with a TypeError
    // ("Failed to fetch", no statusCode) — the endpoint never answered, which
    // is a different truth from a 5xx and must not be labeled "unreachable"
    // (spec §2, owner's incident).
    const call: CallLLM = async () => {
      throw new TypeError("Failed to fetch");
    };
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("browser_blocked");
  });

  it("maps a transport timeout to timeout, distinct from browser_blocked and unreachable", async () => {
    const call: CallLLM = async () => {
      throw new Error("Request timed out after 10000ms");
    };
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
  });

  it("classifies a browser-blocked fetch through the REAL transport as browser_blocked", async () => {
    // Incident repro: the app's actual transport (createOpenAICompatible +
    // generateText) passes a no-cause fetch TypeError straight through —
    // provider-utils handleFetchError only wraps TypeErrors that carry a
    // `cause`. Stubbing global fetch like transport.test.ts, the classifier
    // must still see the browser-block lane.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    // No callLLM → the real defaultCallLLM transport runs.
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages,
      provider,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("browser_blocked");
  });

  it("does not retry when the first call fails at the transport level", async () => {
    const call = vi.fn<CallLLM>(async () => {
      throw new Error("boom");
    });
    const r = await generateRecords({
      schema: Rec,
      knownKeys: ["id"],
      messages: [],
      provider,
      callLLM: call,
    });
    expect(r.ok).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
