/**
 * W52 · KV-format record blocks (issue #52) — replace JSON arrays as the
 * structured AI output surface.
 *
 * Why: small open-weight models are markedly worse at JSON (whole-batch
 * invalidity, truncation kills the array, quote-escaping corrupts verbatim
 * quotes — the owner's schema_failure incident) than at flat key/value lines.
 * Zero escaping is decisive for spec §2 verbatim-quote verification; one bad
 * or truncated record is dropped WITHOUT sinking the good head (per-record
 * salvage, vs. JSON where one short `]` changes the whole batch); and it is
 * ~25-38% fewer output tokens.
 *
 * The parser is tolerant (CRLF, 1+ blank lines between blocks, continuation
 * lines, dotted keys → nesting) and, as a SALVAGE only, also reads a JSON
 * array the model emitted anyway. The format itself is never JSON.
 *
 * Honest degradation (spec §2): generateRecords re-prompts ONCE when nothing
 * survives, then degrades to schema_failure. It never throws on a model
 * failure (abort propagates) and never re-emits a dropped record's content
 */

import { z } from "zod";
import {
  getProviderConfig,
  NO_KEY_MESSAGE,
  type ProviderOverrideInput,
} from "./provider";
import {
  defaultCallLLM,
  type AIKind,
  type AIResult,
  type CallLLM,
  type LLMMessage,
} from "./output";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface KvOptions<T> {
  /** Per-block zod gate — a block that fails is dropped, not fatal. */
  schema?: z.ZodType<T>;
  /** Keys the model is told to emit. Drives the known-key classifier, the
   * re-prompt, and protects the salvage (a bare `snippet:` line is a parent
   * of `snippet.text`, never a bare value). */
  knownKeys: readonly string[];
  /** Keys whose value must be an integer (dropped when not). */
  numbers?: readonly string[];
  /** Keys whose value is a number (integer or decimal, `75%` accepted). */
  floats?: readonly string[];
  /** Keys whose value is true/false (anything else drops the key). */
  booleans?: readonly string[];
  /** Keys whose value is a list: comma- AND continuation-line separated. */
  lists?: readonly string[];
}

export interface KvParseResult<T> {
  records: T[];
  /** Per-block gate issues (only meaningful when records is empty). */
  issues: string[];
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 1+ blank lines separate records; a block must have a non-blank line. */
function splitBlocks(text: string): string[] {
  return text
    .split(/\n[ \t]*(?:\n[ \t]*)+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function toNumber(v: string): number | undefined {
  const t = v.trim();
  if (!/^-?\d+(?:\.\d+)?%?$/.test(t)) return undefined;
  const n = Number(t.replace(/%$/, ""));
  return Number.isFinite(n) ? n : undefined;
}

function toBoolean(v: string): boolean | undefined {
  const t = v.trim().toLowerCase();
  return t === "true" ? true : t === "false" ? false : undefined;
}

function toList(v: string): string[] {
  return v
    .split(/,|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse ONE block's lines into a flat key→value model (continuations already
 * folded in). Returns null when the block has no recognized keys at all.
 * Longest-prefix-first so `snippet.text` wins over `snippet`. */
function blockToEntries(
  block: string,
  knownKeys: readonly string[],
  listKeys: readonly string[],
): Array<[string, unknown]> | null {
  const sorted = [...knownKeys].sort((a, b) => b.length - a.length);
  const entries: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  let lastKey: string | null = null;

  const pushCont = (line: string): void => {
    if (lastKey === null) return;
    if (listKeys.includes(lastKey)) {
      // A list's continuation line is a NEW item (newline), not a space.
      const idx = entries.findIndex(([k]) => k === lastKey);
      const [k, v] = entries[idx];
      entries[idx] = [k, `${String(v)}\n${line}`];
      return;
    }
    const idx = entries.findIndex(([k]) => k === lastKey);
    const [k, v] = entries[idx];
    entries[idx] = [k, v ? `${String(v)} ${line}` : line];
  };

  for (const raw of block.split("\n")) {
    if (isBlank(raw)) continue;
    const line = raw.trim();
    const match = sorted.find((k) => line === k || line.startsWith(k + ":"));
    if (match === undefined) {
      pushCont(line);
      continue;
    }
    const value = line === match ? "" : line.slice(match.length + 1).trim();
    // First-wins on a duplicate key (spec §2: never let prose that looks
    // like another known key silently overwrite a real field — last-wins
    // would corrupt e.g. a snippet's own content into the title slot,
    // passing zod with junk). The duplicate's line continues the CURRENT
    // in-context value (the value the previous key is accumulating), so
    // nothing is silently dropped and the zod gate sees the honest record.
    if (seen.has(match)) {
      pushCont(`${match}: ${value}`);
      continue;
    }
    seen.add(match);
    lastKey = match;
    entries.push([match, value]);
  }
  return entries.length > 0 ? entries : null;
}

/** Fold the flat key→value model into a nested object. A dotted segment that
 * is numeric (e.g. `snippet.highlights.0.start`) builds an array at that
 * level — the JSON-salvage path emits index keys. */
function materialize(
  entries: Array<[string, unknown]>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [path, value] of entries) {
    const parts = path.split(".");
    let cur: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = parts[i + 1];
      if (/^\d+$/.test(next)) {
        const arr = cur[p];
        if (!Array.isArray(arr)) cur[p] = [];
        const idx = Number(next);
        const slot = (cur[p] as unknown[])[idx];
        if (slot !== null && typeof slot === "object" && !Array.isArray(slot)) {
          cur = slot as Record<string, unknown>;
        } else {
          const rec: Record<string, unknown> = {};
          (cur[p] as unknown[]).splice(idx, 0, rec);
          cur = rec;
        }
        i++; // consumed the index
        continue;
      }
      const existing = cur[p];
      if (
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        cur = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        cur[p] = next;
        cur = next;
      }
    }
    cur[parts[parts.length - 1]] = value;
  }
  return obj;
}

function coerce(
  entries: Array<[string, unknown]>,
  ints: readonly string[],
  floats: readonly string[],
  bools: readonly string[],
  listKeys: readonly string[],
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of entries) {
    if (ints.includes(k)) {
      const n = toNumber(String(v));
      if (n === undefined) continue; // non-integer → drop the key
      out.push([k, n]);
    } else if (floats.includes(k)) {
      const n = toNumber(String(v));
      if (n === undefined) continue; // not a number → drop the key
      out.push([k, n]);
    } else if (bools.includes(k)) {
      const b = toBoolean(String(v));
      if (b === undefined) continue; // not true/false → drop the key
      out.push([k, b]);
    } else if (listKeys.includes(k)) {
      out.push([k, toList(String(v))]);
    } else {
      out.push([k, String(v)]);
    }
  }
  return out;
}

/** The salvage: a model that emitted a JSON array of objects anyway. Each
 * element is flattened to the SAME key→value model and run through the same
 * per-block gate — so a JSON batch degrades per-record too. A single JSON
 * object (not an array) is NOT salvaged: the format is records, not one blob. */
function salvageJson(text: string): Array<Array<[string, unknown]>> | null {
  const trimmed = text.trim();
  const candidate =
    trimmed.startsWith("[") || trimmed.startsWith("{")
      ? trimmed
      : (/```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() ?? null);
  if (candidate === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: Array<Array<[string, unknown]>> = [];
  for (const el of data) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) continue;
    const entries: Array<[string, unknown]> = [];
    const walk = (o: Record<string, unknown>, prefix: string): void => {
      for (const [k, v] of Object.entries(o)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (Array.isArray(v)) {
          v.forEach((item, i) => {
            if (
              item !== null &&
              typeof item === "object" &&
              !Array.isArray(item)
            ) {
              walk(item as Record<string, unknown>, `${path}.${i}`);
            } else {
              entries.push([
                `${path}.${i}`,
                item as string | number | boolean | null,
              ]);
            }
          });
        } else if (v !== null && typeof v === "object") {
          walk(v as Record<string, unknown>, path);
        } else {
          entries.push([path, v as string | number | boolean | null]);
        }
      }
    };
    walk(el as Record<string, unknown>, "");
    if (entries.length > 0) out.push(entries);
  }
  return out.length > 0 ? out : null;
}

/** Parse a raw model response into per-block records. Tolerant (CRLF, 1+
 * blank lines, continuations, dotted keys); salvages a JSON array.
 * 0 surviving records → `{ records: [], issues }` (the caller re-prompts). */
export function parseRecords<T>(
  text: string,
  opts: KvOptions<T>,
): KvParseResult<T> {
  const {
    knownKeys,
    schema,
    numbers = [],
    floats = [],
    booleans = [],
    lists = [],
  } = opts;
  const sorted = [...knownKeys].sort((a, b) => b.length - a.length);
  const ints = [...numbers].filter((n) => sorted.includes(n));
  const flts = [...floats].filter((n) => sorted.includes(n));
  const bools = [...booleans].filter((n) => sorted.includes(n));
  const listKeys = [...lists].filter((l) => sorted.includes(l));
  const normalized = normalize(text);

  let blocks = splitBlocks(normalized)
    .map((b) => blockToEntries(b, knownKeys, listKeys))
    .filter((e): e is Array<[string, unknown]> => e !== null);
  if (blocks.length === 0) blocks = salvageJson(normalized) ?? [];

  const records: T[] = [];
  const issues: string[] = [];
  for (const raw of blocks) {
    const obj = materialize(coerce(raw, ints, flts, bools, listKeys));
    if (schema) {
      const parsed = schema.safeParse(obj);
      if (!parsed.success) {
        issues.push(
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "block"}: ${i.message}`)
            .join("; "),
        );
        continue;
      }
      records.push(parsed.data);
    } else {
      records.push(obj as T);
    }
  }
  if (records.length === 0 && issues.length === 0)
    issues.push("no record recognized");
  return { records, issues };
}
/* ------------------------------------------------------------------ *
 * LLM boundary
 * ------------------------------------------------------------------ */

export interface GenerateRecordsOptions<T> {
  schema: z.ZodType<T>;
  knownKeys: readonly string[];
  numbers?: readonly string[];
  /** Keys whose value is a number (integer or decimal, `75%` accepted). */
  floats?: readonly string[];
  /** Keys whose value is true/false (anything else drops the key). */
  booleans?: readonly string[];
  lists?: readonly string[];
  /** Hard cap on records, applied in order after salvage — mirrors the
   * old array-schema `.max(n)` so a partial salvage can't exceed the bound
   * the prompt stated (spec §2: never report more than was asked). */
  max?: number;
  /** Agent's domain prompt; the KV format instruction is PREPENDED so the
   * prompt can never drift from the gate. */
  system?: string;
  messages: LLMMessage[];
  /** Default 0.2 (grill Q5: one small model, temp 0.2 for extraction). */
  temperature?: number;
  abortSignal?: AbortSignal;
  /** BYOK override resolved through provider.ts (ADR-018: apiKey never echoed). */
  provider?: ProviderOverrideInput;
  /** Test seam; defaults to the app's shared transport (output's defaultCallLLM). */
  callLLM?: CallLLM;
}

/** Format the model must emit — derived from the known keys. */
export function formatInstruction(
  knownKeys: readonly string[],
  notes?: Record<string, string>,
): string {
  const lines = knownKeys.map((k) =>
    notes?.[k] ? `${k}: <${notes[k]}>` : `${k}: <value>`,
  );
  return (
    "Respond with records: `key: value` lines, one record per blank line. " +
    "NO JSON, no quotes needed, no prose outside the records. Exactly these keys:\n" +
    lines.join("\n")
  );
}

function kindOf(err: unknown): AIKind {
  const msg = String((err as Error | null)?.message ?? err).toLowerCase();
  if (/timeout|timed out|etimedout|deadline/i.test(msg)) return "timeout";
  // A fetch that rejected with no HTTP response is the browser-block lane
  // (spec §2 never-lie). On the gateway branch the GatewayError carries
  // `network: true`; on main the raw TypeError passes through. Both read.
  if (
    (err as { network?: boolean } | null)?.network === true ||
    (err instanceof TypeError &&
      /failed to fetch|fetch failed|networkerror|load failed|mixed content/i.test(
        msg,
      ))
  ) {
    return "browser_blocked";
  }
  return "unreachable";
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (err as { name?: string } | null)?.name === "AbortError" ||
    String((err as Error | null)?.message ?? "")
      .toLowerCase()
      .includes("abort")
  );
}

/** Parse + apply the `max` cap in order (the prompt's bound is a hard one). */
function cappedParse<T>(
  text: string,
  opts: KvOptions<T>,
  max?: number,
): KvParseResult<T> {
  const r = parseRecords(text, opts);
  return max !== undefined
    ? { records: r.records.slice(0, max), issues: r.issues }
    : r;
}
/** Scrub the configured key out of a message for lane logging (ADR-018):
 * error bodies can echo the request URL, which for a key-in-query-string
 * endpoint shape would otherwise leak into console.debug. The raw message
 * stays on the AIResult (the caller's honest-degrade path truncates it
 * before it reaches the banner). */
export function scrubKey(msg: unknown, apiKey: string): string {
  const s = String((msg as Error | null)?.message ?? msg);
  return apiKey ? s.split(apiKey).join("<key>") : s;
}

/**
 * Generate a list of records from a prompt, KV-gated at our boundary, with
 * exactly ONE re-prompt when nothing survives. Never throws on a model
 * failure (abort propagates); degrades honestly to an AIResult.
 */
export async function generateRecords<T>(
  opts: GenerateRecordsOptions<T>,
): Promise<AIResult<T[]>> {
  const {
    schema,
    knownKeys,
    numbers,
    floats,
    booleans,
    lists,
    max,
    system,
    messages,
    temperature = 0.2,
    abortSignal,
    provider,
    callLLM: seam,
  } = opts;

  const provRes = getProviderConfig(provider);
  if (!provRes.ok) {
    return provRes.kind === "no_key"
      ? { ok: false, kind: "no_key", message: NO_KEY_MESSAGE }
      : {
          ok: false,
          kind: "invalid_request",
          message: provRes.issues.join("; "),
        };
  }

  const call = seam ?? defaultCallLLM;
  // Diagnostic lane for the owner's manual runs (issue: "AI translate
  // degraded (timeout)"). Key-free, content-free — spec §2: never log the
  // dropable record content or the apiKey, only shapes + timings.
  const started = Date.now();
  const lane = provider?.name ?? "default";
  const el = () => `${String(Date.now() - started).padStart(5, " ")}ms`;
  const dbg = (msg: string) => console.debug(`[ai:${lane}] ${el()} ${msg}`);
  const sys = [formatInstruction(knownKeys), system]
    .filter(Boolean)
    .join("\n\n");
  const base = {
    provider: provRes.config,
    system: sys,
    messages,
    temperature,
    signal: abortSignal,
  };
  const run = (): Promise<
    { ok: true; text: string } | { ok: false; kind: AIKind; message: string }
  > => {
    const t0 = Date.now();
    return call(base).then(
      (text) => {
        dbg(`resp: ${text.length} chars in ${Date.now() - t0}ms`);
        return { ok: true, text };
      },
      (err: unknown) => {
        if (isAbort(err, abortSignal)) throw err;
        const kind = kindOf(err);
        // The raw message rides the AIResult (the caller's honest-degrade
        // truncates it into the banner); only the lane log is scrubbed.
        const raw = String((err as Error)?.message ?? err);
        dbg(
          `fail: ${kind} after ${Date.now() - t0}ms — ${scrubKey(raw, provRes.config.apiKey)}`,
        );
        return {
          ok: false,
          kind,
          message: raw,
        };
      },
    );
  };

  // Host is in the URL — never the key (spec §2/ADR-018); model + host pin
  // the "empty model hangs LiteLLM" and "wrong base URL" lanes the owner hit.
  const host = (() => {
    try {
      return new URL(provRes.config.baseUrl).host;
    } catch {
      return provRes.config.baseUrl;
    }
  })();
  dbg(
    `call: model=${provRes.config.model || "(EMPTY)"} host=${host} msgs=${messages.length} keys=[${knownKeys.join(" ")}]${max !== undefined ? ` max=${max}` : ""}`,
  );
  let first: Awaited<ReturnType<typeof run>>;
  try {
    first = await run();
  } catch (err) {
    dbg(`throw: ${scrubKey(err, provRes.config.apiKey)} (${kindOf(err)})`);
    throw err;
  }
  if (!first.ok) {
    dbg(`transport ${first.kind}: ${first.message}`);
    return { ok: false, kind: first.kind, message: first.message };
  }
  dbg(`first: ${first.text.length} chars`);
  let parsed = cappedParse(
    first.text,
    { schema, knownKeys, numbers, floats, booleans, lists },
    max,
  );
  dbg(`parse: ${parsed.records.length} records, ${parsed.issues.length} issues`);
  if (parsed.records.length > 0) return { ok: true, result: parsed.records };

  // Exactly one re-prompt: re-state the format + the gate issue. Never echo
  // the dropped record's content (spec §2: it may be an untrustworthy quote).
  const retry = {
    ...base,
    messages: [
      ...messages,
      {
        role: "user" as const,
        content: `Your previous response contained no valid record. ${parsed.issues.join("; ") || "format not recognized"}\n\n${formatInstruction(knownKeys)}\n\nReturn the records again.`,
      },
    ],
  };
  dbg("re-prompt");
  let second: Awaited<ReturnType<typeof run>>;
  try {
    second = await call(retry).then(
      (text) => ({ ok: true, text }) as const,
      (err: unknown) => {
        if (isAbort(err, abortSignal)) throw err;
        return {
          ok: false,
          kind: kindOf(err),
          message: String((err as Error)?.message ?? err),
        } as const;
      },
    );
  } catch (err) {
    dbg(`throw: ${scrubKey(err, provRes.config.apiKey)} (${kindOf(err)})`);
    throw err;
  }
  if (!second.ok) {
    dbg(`transport ${second.kind}: ${second.message}`);
    return { ok: false, kind: second.kind, message: second.message };
  }
  dbg(`second: ${second.text.length} chars`);
  parsed = cappedParse(
    second.text,
    { schema, knownKeys, numbers, floats, booleans, lists },
    max,
  );
  dbg(`parse: ${parsed.records.length} records, ${parsed.issues.length} issues`);
  if (parsed.records.length > 0) return { ok: true, result: parsed.records };

  dbg("schema_failure: no record after re-prompt");
  return {
    ok: false,
    kind: "schema_failure",
    message: `Response had no valid record after one re-prompt. ${parsed.issues[0] ?? "format not recognized"}`,
  };
}
