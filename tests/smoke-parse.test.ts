/**
 * `pnpm smoke:parse` (issue #54): re-parse every raw model response in
 * `.smoke/corpus/` through the real KV parser and print a per-bucket
 * parse-rate diagnostic. Never fails the run — this is a diagnostic for
 * eyeballing model fluency, not a gate.
 *
 * Runs as a vitest "test" because the source tree uses extensionless
 * relative imports (Svelte convention) that Node's ESM resolver rejects;
 * vitest's resolver handles them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseRecords } from "$lib/ai/records";

const Rec = z
  .object({
    id: z.string().optional(),
    kind: z.string().optional(),
    value: z.string().optional(),
    title: z.string().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();

const KNOWN = [
  "id",
  "kind",
  "value",
  "title",
  "snippet",
  "entityId",
  "typeToken",
];

describe("smoke corpus parse-rate diagnostic (issue #54)", () => {
  it("re-parses every raw corpus response through the KV parser", () => {
    const dir = join(process.cwd(), ".smoke", "corpus");
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      console.log(
        "no corpus yet — run `pnpm smoke` and the smoke page first (.smoke/corpus/)",
      );
      return;
    }
    if (files.length === 0) {
      console.log("corpus is empty — run `pnpm smoke` first");
      return;
    }
    let totalBlocks = 0;
    let totalParsed = 0;
    for (const f of files.sort()) {
      const raw = readFileSync(join(dir, f), "utf8");
      // Records are separated by the ␞ record-separator the gateway wrote.
      const entries = raw.split("\u241E").filter((s) => s.trim().length > 0);
      let parsed = 0;
      let blocks = 0;
      for (const entry of entries) {
        if (entry.startsWith("__HTTP_")) {
          blocks++; // a fault injection — unparseable by design
          continue;
        }
        // A never-fail diagnostic: a malformed corpus entry must count as
        // unparseable, not blow up the whole run.
        try {
          const r = parseRecords(entry, { knownKeys: KNOWN, schema: Rec });
          parsed += r.records.length;
        } catch {
          // intentionally swallow — the point of the diagnostic is the rate
        }
        blocks += Math.max(1, entry.split(/\n\n/).length);
      }
      totalBlocks += blocks;
      totalParsed += parsed;
      const rate =
        blocks === 0
          ? "—"
          : `${((parsed / Math.max(1, blocks)) * 100).toFixed(0)}%`;
      console.log(`${f}: ${parsed}/${blocks} blocks parsed (${rate})`);
    }
    console.log(`total: ${totalParsed} records from ${totalBlocks} blocks`);
    expect(true).toBe(true);
  });
});
