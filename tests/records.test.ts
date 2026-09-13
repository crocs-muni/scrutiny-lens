// KV-format record parser (issue #52) — the format is the trust gate for
// verbatim-quote verification (spec §2): zero escaping is decisive, and
// per-record salvage is the whole point (a truncated tail must not sink a
// good head). The parser is pure; the LLM boundary (generateRecords) is
// tested at the end.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateRecords, parseRecords } from "$lib/ai/records";
import type { CallLLM } from "$lib/ai/output";

const Rec = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  snippet: z.string().min(1),
  match: z.number().int().optional(),
  reasons: z.array(z.string()).optional(),
});
const KNOWN = ["id", "title", "snippet", "match", "reasons"];

function rec(p: Record<string, unknown>): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

describe("parseRecords", () => {
  it("parses one flat block", () => {
    const { records } = parseRecords<Record<string, unknown>>(
      rec({ id: "a1", title: "T", snippet: "S" }),
      { knownKeys: KNOWN },
    );
    expect(records).toEqual([{ id: "a1", title: "T", snippet: "S" }]);
  });

  it("splits blocks on one OR MANY blank lines (tolerant)", () => {
    const text = [
      rec({ id: "a", title: "T", snippet: "S" }),
      "",
      "",
      "",
      rec({ id: "b", title: "T", snippet: "S" }),
    ].join("\n");
    expect(parseRecords<Record<string, unknown>>(text, { knownKeys: KNOWN }).records).toHaveLength(2);
  });

  it("normalizes CRLF line endings", () => {
    const { records } = parseRecords<Record<string, unknown>>("id: a\r\ntitle: T\r\nsnippet: S\r\n", {
      knownKeys: KNOWN,
    });
    expect(records[0]).toEqual({ id: "a", title: "T", snippet: "S" });
  });

  it("a non-key line continues the previous key (trailing-space joined)", () => {
    const text =
      "id: a\n" + "title: First line\n" + "  continued line\n" + "snippet: S";
    const { records } = parseRecords<Record<string, unknown>>(text, { knownKeys: KNOWN });
    expect(records[0].title).toBe("First line continued line");
  });

  it("drops a final truncated block missing required keys; keeps good head", () => {
    const good = rec({ id: "a", title: "T", snippet: "S" });
    const truncated = "id: b\ntitle: half";
    const res = parseRecords<Record<string, unknown>>(`${good}\n\n${truncated}`, {
      knownKeys: KNOWN,
      schema: Rec,
    }).records;
    expect(res).toEqual([{ id: "a", title: "T", snippet: "S" }]);
  });

  it("drops a middle bad block; keeps both good neighbors", () => {
    const good = (id: string) => rec({ id, title: "T", snippet: "S" });
    const bad = "id: \ntitle: missing snippet";
    const res = parseRecords<Record<string, unknown>>(`${good("a")}\n\n${bad}\n\n${good("b")}`, {
      knownKeys: KNOWN,
      schema: Rec,
    }).records;
    expect(res.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list when nothing survives", () => {
    const { records, issues } = parseRecords<Record<string, unknown>>(
      "complete gibberish\nno keys here",
      { knownKeys: KNOWN, schema: Rec },
    );
    expect(records).toEqual([]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("dotted keys build nested objects (snippet.text / snippet.highlights.0.start)", () => {
    const text = [
      "id: a",
      "title: T",
      "snippet.text: quoted words",
      "snippet.highlights.0.start: 0",
      "snippet.highlights.0.len: 6",
    ].join("\n");
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: [
        "id",
        "title",
        "snippet.text",
        "snippet.highlights.0.start",
        "snippet.highlights.0.len",
      ],
      numbers: ["snippet.highlights.0.start", "snippet.highlights.0.len"],
    });
    expect(records[0].snippet).toEqual({
      text: "quoted words",
      highlights: [{ start: 0, len: 6 }],
    });
  });

  it("numbers: an integer string coerces, a non-numeric value drops the key", () => {
    const { records } = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: 8", {
      knownKeys: KNOWN,
      numbers: ["match"],
    });
    expect(records[0].match).toBe(8);
    const { records: bad } = parseRecords<Record<string, unknown>>(
      "id: a\ntitle: T\nsnippet: S\nmatch: high",
      { knownKeys: KNOWN, numbers: ["match"] },
    );
    expect(bad[0]).not.toHaveProperty("match");
  });
  it("floats: a decimal coerces, a percentage coerces, a non-numeric value drops the key", () => {
    const ok = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: 0.65", {
      knownKeys: KNOWN,
      floats: ["match"],
    });
    expect(ok.records[0].match).toBe(0.65);
    const pct = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: 75%", {
      knownKeys: KNOWN,
      floats: ["match"],
    });
    expect(pct.records[0].match).toBe(75);
    const bad = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: high", {
      knownKeys: KNOWN,
      floats: ["match"],
    });
    expect(bad.records[0]).not.toHaveProperty("match");
  });

  it("booleans: true/false coerce, anything else drops the key", () => {
    const t = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: true", {
      knownKeys: KNOWN,
      booleans: ["match"],
    });
    expect(t.records[0].match).toBe(true);
    const f = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: false", {
      knownKeys: KNOWN,
      booleans: ["match"],
    });
    expect(f.records[0].match).toBe(false);
    const bad = parseRecords<Record<string, unknown>>("id: a\ntitle: T\nsnippet: S\nmatch: yes", {
      knownKeys: KNOWN,
      booleans: ["match"],
    });
    expect(bad.records[0]).not.toHaveProperty("match");
  });
  it("lists: comma- and newline-separated values become an array of trimmed strings", () => {
    const text = "id: a\ntitle: T\nsnippet: S\nreasons: alpha, beta\n  gamma";
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: KNOWN,
      lists: ["reasons"],
    });
    expect(records[0].reasons).toEqual(["alpha", "beta", "gamma"]);
  });

  it("first-wins on a duplicate key: a prose line that matches another known key folds into the current value, never overwrites the first (spec §2)", () => {
    // The snippet's prose quotes a `category:`-shaped line. Last-wins would
    // silently swap the title; first-wins must keep the first title and
    // fold the collision into the running value, surfaced honestly by zod
    // or the gate downstream.
    const text =
      "id: a\ntitle: Real title\nsnippet: A snippet mentioning category: BSI EAL4+ as a fact.\ntitle: Category: BSI EAL4+";
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: KNOWN,
      schema: Rec,
    });
    expect(records[0].title).toBe("Real title");
    expect(records[0].snippet).toBe(
      "A snippet mentioning category: BSI EAL4+ as a fact. title: Category: BSI EAL4+",
    );
  });

  it("an unrecognized mid-record line appends to the running value (continuation), so nothing is silently dropped", () => {
    const text = [
      "id: a",
      "title: T",
      "snippet: S detail one",
      "assurance: EAL4+", // NOT a known key here → continuation, not a new field
      "more detail two",
    ].join("\n");
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: KNOWN,
    });
    expect(records[0].snippet).toBe("S detail one assurance: EAL4+ more detail two");
    expect(records[0]).not.toHaveProperty("assurance");
  });

  it("a duplicate list-key line adds a new item, not a silent overwrite", () => {
    const text = [
      "id: a",
      "title: T",
      "snippet: S",
      "reasons: one",
      "reasons: two",
    ].join("\n");
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: KNOWN,
      lists: ["reasons"],
    });
    expect(records[0].reasons).toEqual(["one", "reasons: two"]);
  });

  it("JSON salvage nests objects and index-keys arrays (snippet.highlights)", () => {
    const text = JSON.stringify([
      {
        id: "a",
        title: "T",
        snippet: { text: "quoted", highlights: [{ start: 0, len: 6 }] },
      },
    ]);
    const { records } = parseRecords<Record<string, unknown>>(text, {
      knownKeys: [
        "id",
        "title",
        "snippet.text",
        "snippet.highlights.0.start",
        "snippet.highlights.0.len",
      ],
      numbers: ["snippet.highlights.0.start", "snippet.highlights.0.len"],
    });
    expect(records[0].snippet).toEqual({
      text: "quoted",
      highlights: [{ start: 0, len: 6 }],
    });
  });

  it("a single JSON object (not an array) is NOT salvaged as one record", () => {
    const text = JSON.stringify({ id: "a", title: "T", snippet: "S" });
    expect(
      parseRecords<Record<string, unknown>>(text, { knownKeys: KNOWN, schema: Rec }).records,
    ).toEqual([]);
  });

  it("a fenced JSON array is salvaged", () => {
    const text =
      "```json\n" +
      JSON.stringify([{ id: "a", title: "T", snippet: "S" }]) +
      "\n```";
    expect(
      parseRecords<Record<string, unknown>>(text, { knownKeys: KNOWN, schema: Rec }).records,
    ).toHaveLength(1);
  });
});

const PROV = {
  name: "e-infra",
  baseUrl: "https://llm.fi.muni.cz/v1",
  model: "gemma4",
  apiKey: "k",
};

describe("generateRecords", () => {
  it("returns parsed records on the first call", async () => {
    const res = await generateRecords({
      schema: Rec,
      knownKeys: KNOWN,
      messages: [{ role: "user", content: "x" }],
      provider: PROV,
      callLLM: (async () =>
        rec({ id: "a", title: "T", snippet: "S" })) as CallLLM,
    });
    expect(res).toEqual({
      ok: true,
      result: [{ id: "a", title: "T", snippet: "S" }],
    });
  });

  it("re-prompts ONCE when nothing survives, then succeeds", async () => {
    let n = 0;
    const call: CallLLM = async () => {
      n += 1;
      return n === 1 ? "garbage" : rec({ id: "a", title: "T", snippet: "S" });
    };
    const res = await generateRecords({
      schema: Rec,
      knownKeys: KNOWN,
      messages: [],
      provider: PROV,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("caps records at max, in order (the prompt bound is hard)", async () => {
    const call: CallLLM = async () =>
      [
        rec({ id: "a", title: "T", snippet: "S" }),
        rec({ id: "b", title: "T", snippet: "S" }),
        rec({ id: "c", title: "T", snippet: "S" }),
      ].join("\n\n");
    const res = await generateRecords({
      schema: Rec,
      knownKeys: KNOWN,
      max: 2,
      messages: [],
      provider: PROV,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("schema_failure after one re-prompt; the message never re-emits a dropped bad record", async () => {
    const call: CallLLM = async () => rec({ id: "a", title: "T" }); // no snippet
    const res = await generateRecords({
      schema: Rec,
      knownKeys: KNOWN,
      messages: [],
      provider: PROV,
      callLLM: call,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("schema_failure");
  });

  it("a transport failure degrades to its kind, not schema_failure", async () => {
    const call: CallLLM = async () => {
      throw new Gatewayish("unreachable: exhausted attempts");
    };
    const res = await generateRecords({
      schema: Rec,
      knownKeys: KNOWN,
      messages: [],
      provider: PROV,
      callLLM: call,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("unreachable");
  });
});

describe("API key scrubbing in the lane log (ADR-018)", () => {
  it("the console.debug lane never leaks the configured apiKey, even when the transport error echoes the request URL", async () => {
    const seen: string[] = [];
    const orig = console.debug;
    console.debug = (...args: unknown[]) => {
      seen.push(args.map((a) => String(a)).join(" "));
    };
    const SECRET = "sk-live-1234567890";
    const call: CallLLM = async () => {
      // The failure shape that bit dbPrivacy: the error message embeds the
      // request URL, which itself carries the key.
      throw new Error(
        `GET https://api.example.com/v1/chat?key=${SECRET} failed with 401`,
      );
    };
    try {
      const res = await generateRecords({
        schema: Rec,
        knownKeys: KNOWN,
        messages: [],
        provider: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: SECRET } as never,
        callLLM: call,
      });
      expect(res.ok).toBe(false);
      // The raw truth rides the AIResult (the caller's honest-degrade path
      // truncates it into the banner)…
      if (!res.ok) expect(res.message).toContain(SECRET);
      // … but the log lane must be scrubbed.
      const lane = seen.join("\n");
      expect(lane).not.toContain(SECRET);
      expect(lane).toContain("<key>");
    } finally {
      console.debug = orig;
    }
  });

  it("a key-free error message passes through the lane unchanged", async () => {
    const seen: string[] = [];
    const orig = console.debug;
    console.debug = (...args: unknown[]) => {
      seen.push(args.map((a) => String(a)).join(" "));
    };
    const call: CallLLM = async () => {
      throw new Error("upstream 500");
    };
    try {
      await generateRecords({
        schema: Rec,
        knownKeys: KNOWN,
        messages: [],
        provider: PROV,
        callLLM: call,
      });
      const lane = seen.join("\n");
      expect(lane).toContain("upstream 500");
    } finally {
      console.debug = orig;
    }
  });
});

class Gatewayish extends Error {
  readonly statusCode?: number;
  constructor(m: string, s?: number) {
    super(m);
    this.name = "GatewayError";
    this.statusCode = s;
  }
}
