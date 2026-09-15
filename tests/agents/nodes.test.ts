import { describe, it, expect, beforeEach } from "vitest";
import type { NostrEvent } from "$lib/fabric";
import type { CallLLM, CallLLMArgs } from "$lib/ai/output";
import { clearDeadLetters, deadLetters } from "$lib/ai/deadLetter";
import {
  batchNodeInterpret,
  BATCH_SIZE,
  ProductNodeVMSchema,
  VulnerabilityNodeVMSchema,
  MetadataNodeVMSchema,
  UnknownNodeVMSchema,
} from "$lib/ai/agents/nodes";

const PROVIDER = {
  baseUrl: "https://llm.example.com/v1",
  model: "test-model",
  apiKey: "test-key",
};

/* ---------- fabric-conformant fixtures ---------- */

const PUBKEY = "a".repeat(64);
const SIG = "b".repeat(128);

function hexId(seed: number): string {
  return seed.toString(16).padStart(2, "0").repeat(32);
}

function fabric(
  seed: number,
  typeTag: string,
  extraTags: string[][],
  content: string,
): NostrEvent {
  return {
    id: hexId(seed),
    pubkey: PUBKEY,
    sig: SIG,
    kind: 1,
    created_at: 1785542440 + seed,
    tags: [
      ["t", "scrutiny-fabric"],
      ["t", typeTag],
      ["t", "scrutiny-v0.8.0"],
      ...extraTags,
    ],
    content,
  };
}

function product(
  seed: number,
  extraTags: string[][] = [],
  content = "Infineon M7794 A2 smartcard IC.",
): NostrEvent {
  return fabric(seed, "scrutiny-product", extraTags, content);
}

function metadata(
  seed: number,
  content: string,
  extraTags: string[][] = [],
): NostrEvent {
  return fabric(seed, "scrutiny-metadata", extraTags, content);
}

function binding(
  seed: number,
  rootId: string,
  linkId: string,
  content: string,
): NostrEvent {
  return fabric(
    seed,
    "scrutiny-binding",
    [
      ["e", rootId, "", "root", PUBKEY],
      ["e", linkId, "", "link", PUBKEY],
    ],
    content,
  );
}

function patch(seed: number, targetId: string): NostrEvent {
  return fabric(
    seed,
    "scrutiny-patch",
    [["e", targetId, "", "root", PUBKEY]],
    "```diff\n title: rename\n```",
  );
}

/** A plain non-fabric note: not-a-SCRUTINY event → routed to kind 'unknown'. */
function plainEvent(seed: number, content: string): NostrEvent {
  return {
    id: hexId(seed),
    pubkey: PUBKEY,
    sig: SIG,
    kind: 1,
    created_at: 1785542440 + seed,
    tags: [],
    content,
  };
}

/* ---------- fake LLM ---------- */

function fakeLLM(json: string): { call: CallLLM; calls: CallLLMArgs[] } {
  const calls: CallLLMArgs[] = [];
  const call: CallLLM = async (args) => {
    calls.push(args);
    return json;
  };
  return { call, calls };
}

const CTX = { rootSummary: "Infineon M7794 · ROCA exposure", query: "ROCA" };

/* ---------- dead-letter isolation ---------- */

beforeEach(() => clearDeadLetters());

function deadLetterRows(): Array<{ entityId: string; reason: string }> {
  return deadLetters().map((e) => ({ entityId: e.entityId, reason: e.reason }));
}

/* ---------- per-kind routing ---------- */

describe("batchNodeInterpret — kind dispatch", () => {
  it("routes a fabric product to a ProductNodeVM with deterministic + draft fields", async () => {
    const prod = product(1, [
      ["identifier", "BSI-DSZ-CC-0814-2012"],
      ["scheme", "BSI"],
      ["eal", "EAL4+"],
      ["status", "active"],
    ]);
    const report = metadata(2, "Security target for M7794 A2.", [
      ["m", "report"],
    ]);
    const edge = binding(3, prod.id, report.id, "Security Target binding.");
    const upd = patch(4, prod.id);

    const { call } = fakeLLM(
      [
        `entityId: ${prod.id}`,
        "title: Infineon M7794 A2",
        "typeToken: smartcard",
        "isRoot: true",
      ].join("\n") +
        "\n\n" +
        [
          `entityId: ${report.id}`,
          "title: Security target",
          "typeToken: report",
          "label: Security target M7794",
          "metaType: report",
        ].join("\n") +
        "\n\n" +
        [
          `entityId: ${edge.id}`,
          "title: ST binding",
          "typeToken: document",
          "summary: Security Target binding.",
        ].join("\n") +
        "\n\n" +
        [
          `entityId: ${upd.id}`,
          "title: Rename patch",
          "typeToken: patch",
          "summary: title: rename",
        ].join("\n"),
    );

    const res = await batchNodeInterpret({
      events: [prod, report, edge, upd],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[0];
    expect(ProductNodeVMSchema.safeParse(node).success).toBe(true);
    if (node.kind !== "product") throw new Error("expected product");
    expect(node.entityId).toBe(prod.id);
    expect(node.title).toBe("Infineon M7794 A2");
    expect(node.typeToken).toBe("smartcard");
    expect(node.status).toBe("active");
    expect(node.retracted).toBe(false);
    expect(node.isRoot).toBe(true);
    expect(node.identifier).toBe("BSI-DSZ-CC-0814-2012");
    expect(node.scheme).toBe("BSI");
    expect(node.assurance).toBe("EAL4+");
    expect(node.updates).toBe(1); // the patch e-tags the product
    expect(node.bindings).toEqual([
      { metaType: "report", label: "Security Target binding." },
    ]);
  });

  it("routes a fabric product with a cve tag to a VulnerabilityNodeVM", async () => {
    const vuln = product(
      1,
      [["cve", "CVE-2017-15361"]],
      "ROCA: Return of Coppersmith Attack on RSA key generation.",
    );
    const prod = product(2, [], "Infineon M7794 A2 smartcard IC.");
    const edge = binding(3, vuln.id, prod.id, "Affected product binding.");
    const { call } = fakeLLM(
      [
        `entityId: ${vuln.id}`,
        "title: ROCA",
        "typeToken: vulnerability",
        "identifier: CVE-2017-15361",
        "identifierKind: cve",
        "severity: High",
      ].join("\n") +
        "\n\n" +
        [`entityId: ${prod.id}`, "title: M7794", "typeToken: smartcard"].join(
          "\n",
        ) +
        "\n\n" +
        [
          `entityId: ${edge.id}`,
          "title: binding",
          "typeToken: document",
          "summary: Affected product binding.",
        ].join("\n"),
    );
    const res = await batchNodeInterpret({
      events: [vuln, prod, edge],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[0];
    expect(VulnerabilityNodeVMSchema.safeParse(node).success).toBe(true);
    if (node.kind !== "vulnerability")
      throw new Error("expected vulnerability");
    expect(node.identifier).toBe("CVE-2017-15361");
    expect(node.identifierKind).toBe("cve");
    expect(node.severity).toBe("High");
  });

  it("routes a fabric metadata event to a MetadataNodeVM", async () => {
    const prod = product(1);
    const report = metadata(2, "Certification report for M7794 A2.", [
      ["m", "report"],
    ]);
    const edge = binding(3, prod.id, report.id, "Certification report.");

    const { call } = fakeLLM(
      [
        [`entityId: ${prod.id}`, "title: M7794", "typeToken: smartcard"].join(
          "\n",
        ),
        [
          `entityId: ${report.id}`,
          "title: Certification report",
          "typeToken: report",
          "label: Certification report M7794",
          "metaType: report",
          "date: 2024-05",
        ].join("\n"),
        [
          `entityId: ${edge.id}`,
          "title: binding",
          "typeToken: document",
          "summary: Certification report.",
        ].join("\n"),
      ].join("\n\n"),
    );
    const res = await batchNodeInterpret({
      events: [prod, report, edge],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[1];
    expect(MetadataNodeVMSchema.safeParse(node).success).toBe(true);
    if (node.kind !== "metadata") throw new Error("expected metadata");
    expect(node.metaType).toBe("report");
    expect(node.label).toBe("Certification report M7794");
    expect(node.date).toBe("2024-05");
  });

  it("routes a non-fabric event to an UnknownNodeVM with a quote-verified summary", async () => {
    const note = plainEvent(
      1,
      "Oddball relay note mentioning RSA libraries in smartcards (ROCA).",
    );
    const { call } = fakeLLM(
      [
        `entityId: ${note.id}`,
        "title: Oddball note",
        "typeToken: document",
        "summary: mentioning RSA libraries in smartcards",
      ].join("\n"),
    );
    const res = await batchNodeInterpret({
      events: [note],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[0];
    expect(UnknownNodeVMSchema.safeParse(node).success).toBe(true);
    if (node.kind !== "unknown") throw new Error("expected unknown");
    expect(node.summary).toBe("mentioning RSA libraries in smartcards");
    expect(node.typeToken).toBe("document");
  });

  it("retracted flag is carried from the resolver into the NodeVM", async () => {
    const prod = product(1);
    const deletion: NostrEvent = {
      id: hexId(99),
      pubkey: PUBKEY,
      sig: SIG,
      kind: 5,
      created_at: 1785549999,
      tags: [["e", prod.id]],
      content: "",
    };

    const { call } = fakeLLM(
      [`entityId: ${prod.id}`, "title: M7794", "typeToken: smartcard"].join(
        "\n",
      ),
    );
    const res = await batchNodeInterpret({
      events: [prod, deletion],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[0];
    expect(node.retracted).toBe(true);
    expect(node.status).toBe("retracted");
  });
});

/* ---------- honest per-item degrade ---------- */

describe("batchNodeInterpret — per-item degrade", () => {
  it("degrades only the schema-failing item to a skeleton and writes dead_letter", async () => {
    const good = product(1, [
      ["identifier", "BSI-DSZ-CC-0814-2012"],
      ["status", "active"],
    ]);
    const badEvent = product(2);
    const { call } = fakeLLM(
      [
        [
          `entityId: ${good.id}`,
          "title: M7794 A2",
          "typeToken: smartcard",
        ].join("\n"),
        // identifier >50 chars → zod violation (title is repair-clipped, so it cannot trip the schema)
        [
          `entityId: ${badEvent.id}`,
          "title: Bad",
          "typeToken: smartcard",
          `identifier: ${"X".repeat(60)}`,
        ].join("\n"),
      ].join("\n\n"),
    );

    const res = await batchNodeInterpret({
      events: [good, badEvent],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [kept, degraded] = res.result.nodes;
    expect(kept.title).toBe("M7794 A2");
    expect(kept.typeToken).toBe("smartcard");
    expect(ProductNodeVMSchema.safeParse(degraded).success).toBe(true);
    expect(degraded.typeToken).toBe("unknown");
    expect(degraded.status).toBe("unknown");

    const rows = deadLetterRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(badEvent.id);
    expect(rows[0].reason).toContain("node validation failed");
  });

  it("extrapolatory unknown-summary is quote-gated: degrade + dead_letter", async () => {
    const note = plainEvent(1, "Short unparseable relay note.");
    const { call } = fakeLLM(
      [
        `entityId: ${note.id}`,
        "title: Note",
        "typeToken: document",
        "summary: A fabricated sentence nowhere near the content.",
      ].join("\n"),
    );

    const res = await batchNodeInterpret({
      events: [note],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const node = res.result.nodes[0];
    if (node.kind !== "unknown") throw new Error("expected unknown");
    // Degraded: summary is the content clip, not the fabricated sentence.
    expect(node.summary).toBe("Short unparseable relay note.");
    const rows = deadLetterRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain("summary extrapolatory");
  });

  it("LLM failure degrades honestly as an error envelope (no fabricated nodes)", async () => {
    const failing: CallLLM = async () => {
      // Fetch-signature TypeError = the browser-block lane (CORS/mixed
      // content): the classifier must report browser_blocked, not the
      // 5xx "unreachable" truth (spec §2, owner's incident).
      throw new TypeError("fetch failed");
    };
    const res = await batchNodeInterpret({
      events: [product(1)],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: failing,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("browser_blocked");
  });
});

/* ---------- batch discipline ---------- */

describe("batchNodeInterpret — batching", () => {
  it("pages BATCH_SIZE+2 events into exactly 2 LLM calls and preserves order", async () => {
    const n = BATCH_SIZE + 2; // 14
    const events = Array.from({ length: n }, (_, i) => product(i + 1));
    const page = Array.from({ length: BATCH_SIZE }, (_, i) =>
      [`entityId: ${events[i].id}`, "title: M", "typeToken: smartcard"].join(
        "\n",
      ),
    ).join("\n\n");
    const { call, calls } = fakeLLM(page);
    const res = await batchNodeInterpret({
      events,
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls).toHaveLength(2);
    expect(res.result.nodes).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(res.result.nodes[i].entityId).toBe(events[i].id);
    }
  });
});

describe("batchNodeInterpret — payload hygiene", () => {
  it("clips event content to 400 chars before it leaves the browser (privacy + token ceiling, owner ruling 2026-09-16)", async () => {
    // A long artifact dump: head prose identifies the document; the tail
    // marker sits way past the clip window and must never reach the wire.
    const head = "Security target for BSI-DSZ-CC-1185-2023. PDF: https://x.test/st.pdf";
    const tail = "SHA-256: BEYOND-MARKER-MUST-NOT-APPEAR";
    const prod = product(1, [], `${head}\n ${"padding line. ".repeat(60)}\n${tail}`);
    const page = [`entityId: ${prod.id}`, "title: Security target", "typeToken: target"].join("\n");
    const { call, calls } = fakeLLM(page);

    const res = await batchNodeInterpret({
      events: [prod],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const wire = JSON.stringify(calls[0].messages);
    expect(wire).toContain("BSI-DSZ-CC-1185-2023");
    expect(wire).not.toContain("BEYOND-MARKER-MUST-NOT-APPEAR");
    expect(res.ok && res.result.interpretedIds).toEqual([prod.id]);
  });
});

/* ---------- id affinity (spec §2 never-lie) ---------- */

describe("batchNodeInterpret — id affinity", () => {
  it("drops a record echoing a foreign entityId: that node degrades raw and no sibling is poisoned", async () => {
    const p1 = product(1);
    const p2 = product(2);
    const p3 = product(3);
    // The model mangles record 2: it describes event 2 but echoes an id that
    // was never requested. No binding, no adoption: node 2 falls back to its
    // deterministic skeleton (spec §2 never-lie). // TODO: (issue #59) A
    // pure foreign echo was already inert under id-lookup, so this guard is
    // indistinguishable pre/post gate; the repeat/mangle case below is the
    // failing-first proof. Kept as the never-lie contract.
    const { call } = fakeLLM(
      [
        [`entityId: ${p1.id}`, "title: P1", "typeToken: smartcard"].join("\n"),
        [
          `entityId: nope-foreign`,
          "title: P2",
          "typeToken: smartcard",
        ].join("\n"),
        [`entityId: ${p3.id}`, "title: P3", "typeToken: smartcard"].join("\n"),
      ].join("\n\n"),
    );
    const res = await batchNodeInterpret({
      events: [p1, p2, p3],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const nodes = res.result.nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[0].title).toBe("P1");
    expect(nodes[1].entityId).toBe(p2.id); // its own id, never "nope-foreign"
    expect(nodes[1].typeToken).toBe("unknown"); // degraded — did not adopt
    expect(nodes[1].title).not.toBe("P2");
    expect(nodes[2].entityId).toBe(p3.id);
    expect(nodes[2].title).toBe("P3");
  });

  it("drops a record repeating a sibling's entityId: the mangled node stays raw, the id owner keeps its own title", async () => {
    const p1 = product(1);
    const p2 = product(2);
    const p3 = product(3);
    // The model repeats event 3's id for event 2's slot while describing
    // event 2, ordered AFTER event 3's own record: a last-write map would
    // overwrite node 3's draft and poison it.
    const { call } = fakeLLM(
      [
        [`entityId: ${p1.id}`, "title: P1", "typeToken: smartcard"].join("\n"),
        [`entityId: ${p3.id}`, "title: P3", "typeToken: smartcard"].join("\n"),
        [
          `entityId: ${p3.id}`,
          "title: P2-mangle",
          "typeToken: smartcard",
        ].join("\n"),
      ].join("\n\n"),
    );
    const res = await batchNodeInterpret({
      events: [p1, p2, p3],
      graphContext: CTX,
      provider: PROVIDER,
      callLLM: call,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const nodes = res.result.nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[0].title).toBe("P1");
    expect(nodes[1].entityId).toBe(p2.id);
    expect(nodes[1].typeToken).toBe("unknown"); // raw — never adopts the mangle
    expect(nodes[1].title).not.toBe("P2-mangle");
    expect(nodes[2].entityId).toBe(p3.id);
    expect(nodes[2].title).toBe("P3"); // keeps its own record's title
  });
});
