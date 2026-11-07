/**
 * Query translation (issue #28, spec §1/§3): identifiers route DIRECTLY to
 * tag searches, never through AI; prose goes through one zod-gated AI call
 * (≤3 searches, prefixes open per IR-4); no key / AI-down → the deterministic
 * ladder of issue #164 — identifier tag legs plus ≤3 short rare-term text
 * probes, never the raw question.
 */

import { z } from "zod";
import type { AIResult, CallLLM } from "$lib/ai/output";
import { generateRecords } from "$lib/ai/records";
import type { ProviderOverrideInput } from "$lib/ai/provider";

export type SearchRequest = {
  kind: "tag" | "text";
  value: string;
  source: "identifier" | "ai" | "fallback";
};
export type SearchPlan = {
  searches: SearchRequest[];
  /** Why the AI path degraded (299-failure class), when it did — the results
   * surface names this instead of a bare "couldn't structure" (spec §4). */
  degradation?: { kind: string; message: string };
};

/** Indexer prefixes AI is GUIDED toward (protocol passes unknown through opaque — spec §3). */
export const GUIDED_PREFIXES = [
  "cve",
  "cwe",
  "cpe",
  "purl",
  "cc",
  "fips",
  "fcc-id",
  "swid",
  "gtin",
  "pp",
  "vendor",
  "scheme",
  "cc-cert-id",
  "cc-scheme",
] as const;

/* ------------------------------------------------------------------ *
 * Deterministic: identifier detection (spec §2 rule 2 — never AI)
 * ------------------------------------------------------------------ */

// Bare CVE / GHSA tokens in prose (per spec §1 they route directly to tag
// searches; typed prefix:value tokens do too, opaquely per IR-4).
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const GHSA_RE = /\bGHSA(?:-[A-Za-z0-9]{4}){3}\b/gi;
const PURL_RE = /\bpkg:[A-Za-z0-9+._/-]+@[^\s,;"'<>]+/gi;
// Typed prefix:value tokens pass through (IR-4) only when identifier-shaped:
// skip URL schemes ('https://…' is a page, not a tag) and free-prose colons
// ('note: the march…' is grammar, not an identifier). Value must carry at
// least one identifier-ish character beyond a bare word (digit, @, _, -, .).
const PREFIX_VALUE_RE = /\b[A-Za-z0-9-]+:[^\s,;"'<>]*(?:[\d@_.-])[^\s,;"'<>]*/g;

export function detectIdentifiers(question: string): string[] {
  const out = new Set<string>();
  for (const m of question.matchAll(CVE_RE))
    out.add(`cve:${m[0].replace(/cve/i, "CVE")}`);
  for (const m of question.matchAll(GHSA_RE))
    out.add(`ghsa:${m[0].replace(/ghsa/i, "GHSA")}`);
  const purls = new Set<string>(
    [...question.matchAll(PURL_RE)].map((m) => m[0]),
  );
  for (const purl of purls) out.add(`purl:${purl}`);
  for (const m of question.matchAll(PREFIX_VALUE_RE)) {
    if (m[0].includes("://")) continue; // URLs are pages, not tags
    // pkg: tokens are already countable as purls; skip duplicates.
    if (purls.has(m[0])) continue;
    out.add(m[0]);
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * LLM boundary schema — one call, ≤3, guided toward the guided prefixes
 * ------------------------------------------------------------------ */

const SearchDraft = z.object({
  kind: z.enum(["tag", "text"]),
  value: z.string().min(1).max(300),
});
type SearchDraft = z.infer<typeof SearchDraft>;

const SEARCH_KEYS = ["kind", "value"] as const;

const INSTRUCTIONS = [
  "Turn the user question into searches for a nostr security-asset intelligence relay.",
  "Emit ≤3 searches, prefix:value or free text, guided toward these prefixes when plausible:",
  GUIDED_PREFIXES.join(", "),
  "Each search is one record: kind is `tag` (prefix:value) or `text` (free text); value is the query.",
  'Do not interpret interrogative wrapper language (a "still certified" clause becomes a post-filter, not a search).',
  "No other prose.",
].join("\n");

/* ------------------------------------------------------------------ *
 * Deterministic: prefix validation (never reject — IR-4 pass-through)
 * ------------------------------------------------------------------ */

const TAG_VALUE = /^[a-z0-9-]+:\S+$/i;

import { clip } from '$lib/text';

interface TranslateOptions {
  question: string;
  provider?: ProviderOverrideInput;
  callLLM: CallLLM;
  signal?: AbortSignal;
  profile?: string;
}

// 60s: a cold model on a shared BYOK gateway can take 30-60s to answer at
// all (first-use cold-loads are common on LiteLLM-style proxies); 15s
// mislabeled that honest wait as a timeout — every translate call died at
// exactly 15s while the endpoint answered 401s in 150ms.
const TRANSLATE_TIMEOUT_MS = 60_000;

type AiAttempt = {
  searches: SearchRequest[];
  degradation?: SearchPlan["degradation"];
};

async function translateViaAi(
  reminder: string,
  opts: TranslateOptions,
): Promise<AiAttempt> {
  if (!opts.provider) return { searches: [] };
  // The run's signal alone can't distinguish "cold model accepted-but-stalled";
  // its 60s arm lets a hanging translate degrade deterministically (spec §4).
  // generateRecords rethrows aborted-signal errors, so the
  const timer = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS);
  const combined = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
  let result;
  try {
    result = await generateRecords({
      schema: SearchDraft,
      knownKeys: SEARCH_KEYS,
      max: 3,
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: reminder }],
      provider: opts.provider,
      callLLM: opts.callLLM,
      abortSignal: combined,
      temperature: 0.2,
      // Interpret lane (issue #107): a reasoning model's hidden thinking
      // would eat the translate budget — cap it where the endpoint honors it.
      reasoningEffort: "low",
    });
  } catch (err) {
    if (!opts.signal?.aborted && timer.aborted) {
      return {
        searches: [],
        degradation: { kind: "timeout", message: "AI did not answer in 60s" },
      };
    }
    throw err;
  }
  if (!result.ok)
    return {
      searches: [],
      degradation: { kind: result.kind, message: result.message },
    };
  return {
    searches: result.result.flatMap((draft) => {
      const value = draft.value.trim();
      if (value === "") return [];
      if (draft.kind === "tag") {
        return TAG_VALUE.test(value)
          ? [
              {
                kind: "tag",
                value: clip(value, 120),
                source: "ai",
              } as SearchRequest,
            ]
          : [];
      }
      return [
        {
          kind: "text",
          value: clip(value, 120),
          source: "ai",
        } as SearchRequest,
      ];
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic fallback ladder (issue #164, spec §2 rule 5 spirit)
 * ------------------------------------------------------------------ */

/** Words the corpus's record texts do not carry — question grammar, not
 * content. Stripping them leaves the tokens a fabric event can actually
 * match: measured live (issue #164), whole-question probes return zero
 * because the relay's full-text engine ANDs every token and the wrapper
 * language ("which card is fastest for…") is in no event's word index.
 * Interrogatives live here rather than in GENERIC: they match nothing at
 * all ("fastest which" measured 1 hit), so they poison an AND exactly
 * like a stopword. A fixed literal table, never a model call. */
const STOPWORD: Record<string, true> = {
  a: true, an: true, and: true, are: true, as: true, at: true,
  be: true, but: true, by: true, can: true, do: true, does: true,
  for: true, from: true, has: true, have: true, how: true, i: true,
  in: true, is: true, it: true, its: true, me: true, my: true,
  of: true, on: true, or: true, show: true, that: true, the: true,
  their: true, them: true, there: true, these: true, this: true,
  to: true, was: true, were: true, what: true, which: true, who: true,
  why: true, with: true, you: true, your: true,
};

/** Domain wrapper words appearing in thousands of record texts ("card",
 * "cards", "dossier", "affected"…) — kept out of MULTI-token probes where
 * they AND away the rare term's hits (measured live 2026-11-07 on
 * relay.scrutiny.cloud: "roca affected cards" 2 batch-valid vs "roca" 9),
 * but kept as SOLO probes — a generic term alone still hits ("card" 419
 * batch-valid) where an empty ladder would return nothing at all. */
const GENERIC: Record<string, true> = {
  affected: true, card: true, cards: true, certificate: true,
  certified: true, chip: true, chips: true, details: true,
  dossier: true, fastest: true, list: true, module: true,
  platform: true, product: true, smartcard: true, vulnerability: true,
};

type FallbackProbe = { kind: "text"; value: string; source: "fallback" };

/** Short rare-term text probes, longest tokens first (issue #164): the
 * longest surviving token is the rarest discriminator — "ecdsa" /
 * "sle78" / "infineon" are corpus vocabulary where "card" is noise. The
 * ladder narrows first (rarest pair), widening to single terms, so one
 * matching leg is enough for non-zero results; a generic word only
 * carries a probe when nothing rare survived. */
function rareTermProbes(prose: string, max = 3): FallbackProbe[] {
  const tokens = (prose.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter(
    (token) => STOPWORD[token] !== true,
  );
  // Longest first; ties keep first-seen order so the ladder is deterministic.
  const ranked = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  const rare = ranked.filter((token) => GENERIC[token] !== true);
  // Ladder: rare pair → rarest single → widening prefixes of the full
  // ranking (generic words may appear only here, alone or in pairs).
  const ladder: string[][] = [];
  if (rare.length >= 2) ladder.push(rare.slice(0, 2));
  else if (rare.length === 1) ladder.push(rare);
  for (let n = 1; n <= ranked.length; n += 1) ladder.push(ranked.slice(0, n));

  const probes: FallbackProbe[] = [];
  for (const terms of ladder) {
    // A rare pair can repeat as a widening prefix, and prefixes longer than
    // the clip share a head — one probe per distinct query text.
    const value = clip(terms.join(" "), 120);
    if (probes.some((probe) => probe.value === value)) continue;
    probes.push({ kind: "text", value, source: "fallback" });
    if (probes.length >= max) break;
  }
  return probes;
}

/* ------------------------------------------------------------------ *
 * translateQuestion (identifiers → AI → fallback)
 * ------------------------------------------------------------------ */

export async function translateQuestion(
  opts: TranslateOptions,
): Promise<AIResult<SearchPlan>> {
  const question = opts.question.trim();
  if (question === "") return { ok: true, result: { searches: [] } };

  const identifiers = detectIdentifiers(question)
    .map((v) => v.trim())
    .filter((v) => v !== "");

  // Whole-question-is-identifiers: no AI call at all (spec §1). Strip by
  // substring: a bare CVE-2024-1234 matched by the regex must leave the
  // rest of the question as prose for AI translation; only the prefixed
  // form counts as an identifier token (review R2).
  const prose = identifiers
    .reduce((text, id) => {
      const value = id.slice(id.indexOf(":") + 1);
      return text.split(id).join(" ").split(value).join(" ");
    }, question)
    .replace(/\s+/g, " ")
    .trim();

  const proseRemaining =
    identifiers.length === 0
      ? question
      : prose !== "" && prose !== question
        ? prose
        : "";

  if (identifiers.length > 0 && proseRemaining === "") {
    return {
      ok: true,
      result: {
        searches: identifiers.map((value) => ({
          kind: "tag",
          value,
          source: "identifier",
        })),
      },
    };
  }

  let aiSearches: SearchRequest[] = [];
  let degradation: SearchPlan["degradation"];
  let fallbackUsed = false;
  if (proseRemaining !== "") {
    const attempt = await translateViaAi(proseRemaining, opts);
    aiSearches = attempt.searches;
    degradation = attempt.degradation;
    if (aiSearches.length === 0) fallbackUsed = true;
  }

  // spec §1 guarantees every identifier its direct tag route (never
  // dropped — AI translation's ≤3 cap does not blind them). The pipeline
  // renders explicit skeletons immediately; the AI then fills.
  const capped = [
    ...identifiers.map((value) => ({
      kind: "tag" as const,
      value,
      source: "identifier" as const,
    })),
    ...aiSearches.slice(0, 3),
  ];

  return {
    ok: true,
    result: {
      // Issue #164 fallback: identifiers keep their direct tag legs; the
      // prose becomes locally derived rare-term probes, never the question
      // verbatim — the relay's text engine ANDs every token and question
      // grammar is in no event's word index, so a whole-question probe
      // returns zero real hits on the live corpus (see rareTermProbes).
      searches: fallbackUsed ? [...capped, ...rareTermProbes(proseRemaining)] : capped,
      ...(degradation ? { degradation } : {}),
    },
  };
}
