// Reasoning-effort lane wiring (issue #107): the INTERPRET lanes — query
// translation, card interpretation, node interpretation, and the cards
// fill — raise reasoningEffort 'low' on their transport args so their
// time budgets survive reasoning-class models; chat keeps full power.
// The gateway probes the endpoint behaviorally and decides whether the
// param actually rides; these tests pin the LANE side: which lanes set
// the flag on the args the injected transport seam receives.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { NostrEvent } from "$lib/fabric";
import type { CallLLM, CallLLMArgs } from "$lib/ai/output";
import { clearDeadLetters } from "$lib/ai/deadLetter";
import { translateQuestion } from "$lib/ai/agents/query";
import { interpretCards } from "$lib/ai/agents/cards";
import { batchNodeInterpret } from "$lib/ai/agents/nodes";
import { chatground, type StreamLLM as ChatStreamLLM } from "$lib/ai/agents/chat";
import {
  generateRecords,
  streamRecords,
  type StreamLLM,
} from "$lib/ai/records";
import { fillCards, type ProductCard } from "$lib/pipeline/cards";
import { _closeForTests, clearAllLocalData, initPersistence } from "$lib/db";

const PROVIDER = {
  baseUrl: "https://llm.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

function capture(text: string): { call: CallLLM; calls: CallLLMArgs[] } {
  const calls: CallLLMArgs[] = [];
  const call: CallLLM = async (a) => {
    calls.push(a);
    return text;
  };
  return { call, calls };
}

const itemSchema = z.object({ item: z.string() });
const itemOpts = {
  schema: itemSchema,
  knownKeys: ["item"] as const,
  messages: [{ role: "user" as const, content: "q" }],
  provider: PROVIDER,
};

beforeEach(async () => {
  clearDeadLetters();
  await initPersistence();
  await clearAllLocalData();
});

afterEach(async () => {
  await _closeForTests();
});

describe("records boundary threads the flag (issue #107)", () => {
  it("generateRecords passes reasoningEffort to the transport only when set", async () => {
    const low = capture("item: x");
    const res = await generateRecords({
      ...itemOpts,
      callLLM: low.call,
      reasoningEffort: "low",
    });
    expect(res.ok).toBe(true);
    expect(low.calls[0].reasoningEffort).toBe("low");

    const plain = capture("item: x");
    const res2 = await generateRecords({ ...itemOpts, callLLM: plain.call });
    expect(res2.ok).toBe(true);
    expect(plain.calls[0].reasoningEffort).toBeUndefined();
  });

  it("streamRecords passes reasoningEffort to the stream transport when set", async () => {
    const calls: CallLLMArgs[] = [];
    const stream: StreamLLM = async function* (a) {
      calls.push(a);
      yield "item: x";
    };
    const res = await streamRecords({
      ...itemOpts,
      streamLLM: stream,
      reasoningEffort: "low",
    });
    expect(res.ok).toBe(true);
    expect(calls[0].reasoningEffort).toBe("low");
  });
});

describe("interpret lanes raise the flag (issue #107)", () => {
  it("query translation", async () => {
    const { call, calls } = capture("kind: text\nvalue: ROCA chips");
    const res = await translateQuestion({
      question: "tell me about ROCA exposure",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].reasoningEffort).toBe("low");
  });

  it("card interpretation", async () => {
    const graph = {
      entityId: "ev-1",
      event: {
        id: "ev-1",
        sig: "sig",
        pubkey: "pk",
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: "Infineon RSA library used in smartcards (ROCA).",
      },
      neighbors: [],
      stats: { boundMetadata: 0, attachments: 0, updates: 0 },
    };
    const draft = [
      "entityId: ev-1",
      "title: Card 1",
      "typeToken: certificate",
      "snippet.text: BSI EAL4 certificate smartcard.",
      "match: 0.7",
    ].join("\n");
    const { call, calls } = capture(draft);
    const res = await interpretCards({
      graphs: [graph],
      query: "ROCA",
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    expect(calls[0].reasoningEffort).toBe("low");
  });

  it("node interpretation", async () => {
    const ev: NostrEvent = {
      id: "0a".repeat(32),
      pubkey: "a".repeat(64),
      sig: "b".repeat(128),
      kind: 1,
      created_at: 1785542441,
      tags: [
        ["t", "scrutiny-fabric"],
        ["t", "scrutiny-product"],
        ["t", "scrutiny-v0.8.0"],
      ],
      content: "Infineon M7794 A2 smartcard IC.",
    };
    const draft = [`entityId: ${ev.id}`, "title: Infineon M7794"].join("\n");
    const { call, calls } = capture(draft);
    const res = await batchNodeInterpret({
      events: [ev],
      graphContext: { rootSummary: "ROCA", query: "ROCA" },
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    expect(calls[0].reasoningEffort).toBe("low");
  });

  it("the cards fill lane", async () => {
    const card: ProductCard = {
      id: "c1",
      typeTag: "scrutiny-product",
      createdAt: 1700000000,
      pubkey: "ab".repeat(4),
      title: "c1",
      identifiers: ["cve:CVE-2017-15361"],
      retracted: false,
      boundMetadata: 0,
      files: 0,
      updates: 0,
      contentStart: "content of c1",
      interpreted: false,
    };
    const { call, calls } = capture("id: c1\ntitle: T\nsnippet: S");
    const filled = await fillCards([card], {
      provider: PROVIDER,
      callLLM: call,
    });
    expect(filled[0].interpreted).toBe(true);
    expect(calls[0].reasoningEffort).toBe("low");
  });
});

describe("chat keeps full power (issue #107)", () => {
  it("the chat stream transport args carry no flag", async () => {
    const events: NostrEvent[] = [
      {
        id: "ev-1",
        sig: "sig",
        pubkey: "pk",
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: "ROCA exposure note.",
      },
    ];
    const calls: CallLLMArgs[] = [];
    const stream: ChatStreamLLM = async function* (a) {
      calls.push(a);
      yield "Grounded answer text.";
    };
    const rs = chatground({
      question: "What is exposed?",
      history: [],
      groundingEvents: events,
      rootSummary: "ROCA",
      provider: PROVIDER,
      streamLLM: stream,
    });
    const reader = rs.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].reasoningEffort).toBeUndefined();
  });
});
