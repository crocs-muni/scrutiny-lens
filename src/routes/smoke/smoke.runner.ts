/**
 * The smoke run itself (issue #54) — dynamically imported by the dev-only
 * route, so none of these imports enter other routes' graphs or prod builds.
 *
 * Drives the REAL pipeline (translateQuestion + fillCards via defaultCallLLM)
 * against the same-origin fake gateway (scripts/smoke-gateway.ts), whose
 * scripted lanes are keyed by model name. Checks the invariants:
 *   1. every card is filled OR honestly raw (no fabricated text)
 *   2. ≥1 card filled (the happy path works)
 *   3. no api-key fragment anywhere in the output
 *   4. zero transport failures surfaced (the 429s were retried away —
 *      rate_limited counts as one when it escapes the retry budget, #105)
 *   5. the truncated lane salvaged per-card, not all-or-nothing
 *   6. the 429-storm lane (#105): two consecutive throttles halve the
 *      window twice and the last retry still recovers, with the gateway's
 *      surfaced-429 counter seeing both scripted throttles
 * Also logs (never asserts) first-fill latency against spec §7's ~10s bar.
 */
import { translateQuestion } from "$lib/ai/agents/query";
import { fillCards, type ProductCard } from "$lib/pipeline/cards";
import { defaultCallLLM } from "$lib/ai/output";
import { surfaced429Count } from "$lib/ai/gateway";

/** Same-origin fake gateway; the model name selects the scripted lane.
 * A fresh nonce per run: bucket cursors stay unexhausted across reruns AND
 * the model becomes a fresh (eventId, model) interpretation-cache key in
 * IndexedDB, so a previous run's cached fills can't mask the degradation
 * lanes (issue #54: the smoke must be rerunnable with the same result). */
const RUN = Math.random().toString(36).slice(2, 8);

const provider = (model: string) => ({
  name: "smoke",
  baseUrl: new URL("/v1", location.origin).href,
  model: `${model}-${RUN}`,
  apiKey: "smoke-not-a-real-key",
});

function mkCard(i: number): ProductCard {
  return {
    id: `smoke-${i}`,
    typeTag: "product",
    createdAt: 1710000000,
    pubkey: `pk-${i}`,
    // The deterministic fallback title is the first identifier — an
    // honestly-raw card must carry this, not an invented title.
    title: `BSI-DSZ-CC-000${i}`,
    identifiers: [`BSI-DSZ-CC-000${i}`],
    retracted: false,
    boundMetadata: 2,
    files: 1,
    updates: 0,
    contentStart: `Event ${i} content: an Infineon smartcard RSA library affected by the ROCA vulnerability CVE-2017-15361.`,
    interpreted: false,
  };
}

export async function runSmoke(): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  const log = (msg: string) => lines.push(msg);
  const results: Array<[string, boolean, string]> = [];
  // First-fill latency (issue #105, spec §7's ~10s bar): the smoke drives
  // fillCards non-streamed, so the first moment a card can flip interpreted
  // is a fillCards RESOLUTION carrying one — latched on the first chunk.
  const runStart = performance.now();
  let firstFillMs: number | null = null;
  const markFirstFill = (filled: ProductCard[]): void => {
    if (firstFillMs === null && filled.some((c) => c.interpreted)) {
      firstFillMs = performance.now() - runStart;
    }
  };
  try {
    // ── 1. translate lane (429 → KV) ─────────────────────────────
    const t = await translateQuestion({
      question: "ROCA chips",
      provider: provider("smoke-translate"),
      callLLM: defaultCallLLM,
    });
    const okTranslate =
      t.ok && t.result.searches.some((s) => s.source === "ai");
    results.push([
      "translate: ≥1 translated search (the 429 was retried away)",
      okTranslate,
      t.ok ? JSON.stringify(t.result.searches) : `${t.kind}: ${t.message}`,
    ]);

    // ── 2. fill lanes: 6 cards in two chunks of 3 ─────────────────
    const cards = [0, 1, 2, 3, 4, 5].map(mkCard);
    const failures: string[] = [];
    const filledAll: ProductCard[] = [];
    // Chunk A rides the degradation gauntlet (429 → junk → truncated);
    // chunk B completes. Kept as named results so the first interpreted
    // resolution can latch the #105 first-fill latency.
    const filledA = await fillCards(cards.slice(0, 3), {
      provider: provider("smoke-fill-a"),
      callLLM: defaultCallLLM,
      onFailure: (kind) => failures.push(kind),
    });
    markFirstFill(filledA);
    const filledB = await fillCards(cards.slice(3, 6), {
      provider: provider("smoke-fill-b"),
      callLLM: defaultCallLLM,
      onFailure: (kind) => failures.push(kind),
    });
    markFirstFill(filledB);
    filledAll.push(...filledA, ...filledB);

    // invariant: every card interpreted or honestly raw (the raw title
    // is the deterministic identifier fallback, never fabricated).
    const allSettled = filledAll.every(
      (c) => c.interpreted || c.title === `BSI-DSZ-CC-000${c.id.slice(6)}`,
    );
    results.push([
      "fill: every card filled-or-honestly-raw",
      allSettled,
      filledAll.map((c) => `${c.id}:${c.interpreted ? "filled" : "raw"}`).join(" "),
    ]);

    const anyFilled = filledAll.some((c) => c.interpreted);
    results.push([
      "fill: ≥1 card filled (the happy path works)",
      anyFilled,
      "",
    ]);

    const keyLeak = filledAll.some(
      (c) =>
        c.title.includes("smoke-not-a-real") ||
        (c.snippet ?? "").includes("smoke-not-a-real") ||
        c.title.includes("smoke-model") ||
        (c.snippet ?? "").includes("smoke-model"),
    );
    results.push(["fill: no key/model fragment in output", !keyLeak, ""]);

    // The 429 must have been retried away: no transport-kind failure
    // surfaced. rate_limited IS a transport failure here (issue #105 — a
    // 429 the retries couldn't clear reached the surface, and the old list
    // silently excused it); each scripted 429 above is recoverable, so the
    // count must still be zero.
    const transportFailures = failures.filter(
      (f) =>
        f === "unreachable" ||
        f === "timeout" ||
        f === "browser_blocked" ||
        f === "rate_limited",
    );
    results.push([
      "fill: zero transport failures surfaced",
      transportFailures.length === 0,
      failures.join(",") || "none",
    ]);

    // Teeth for the 429 lane: the gateway must have FIRED at least one
    // scripted 429 — without this the check above passes vacuously if the
    // bumper were ever removed from the script.
    let throttled = 0;
    try {
      const st = await fetch("/smoke/status").then((r) => r.json());
      throttled = typeof st.served429 === "number" ? st.served429 : 0;
    } catch {
      /* status endpoint optional; absence is neutral */
    }
    results.push([
      "gateway: at least one scripted 429 was served (the lane can really fail)",
      throttled >= 1,
      `served429=${throttled}`,
    ]);

    // The truncated lane salvaged partially — per-card granularity.
    const chunkA = filledAll.slice(0, 3);
    const salvagedPartial =
      chunkA.some((c) => c.interpreted) && chunkA.some((c) => !c.interpreted);
    results.push([
      "fill: truncated chunk salvaged partially (per-card granularity)",
      salvagedPartial,
      chunkA.map((c) => (c.interpreted ? "filled" : "raw")).join(" "),
    ]);

    // Chunk B fully interpreted.
    const chunkB = filledAll.slice(3, 6);
    results.push([
      "fill: complete chunk fully filled",
      chunkB.every((c) => c.interpreted),
      chunkB.map((c) => (c.interpreted ? "filled" : "raw")).join(" "),
    ]);

    // ── 3. 429 storm lane (issue #105): two CONSECUTIVE throttles — the
    // gateway halves its admission window on each (floor 1; the halving
    // itself is unit-tested in tests/gateway.test.ts) and the final retry
    // of the 3-attempt budget must still recover. This lane keeps its own
    // failures list so the shared zero-transport check above stays scoped
    // to the chunk gauntlet.
    const stormBefore = surfaced429Count();
    const stormFailures: string[] = [];
    const stormFilled = await fillCards([6, 7, 8].map(mkCard), {
      provider: provider("smoke-storm"),
      callLLM: defaultCallLLM,
      onFailure: (kind) => stormFailures.push(kind),
    });
    markFirstFill(stormFilled);
    results.push([
      "storm: fill recovered after consecutive 429s (window halved, then healed)",
      stormFilled.some((c) => c.interpreted),
      `${stormFilled.filter((c) => c.interpreted).length}/3 filled${stormFailures.length > 0 ? ` · ${stormFailures.join(",")}` : ""}`,
    ]);
    // Teeth for the storm: BOTH scripted 429s must have been SEEN app-side
    // — a bucket silently answering 200 would pass the line above.
    const stormSaw = surfaced429Count() - stormBefore;
    results.push([
      "storm: surfaced-429 counter saw both scripted throttles",
      stormSaw >= 2,
      `+${stormSaw}`,
    ]);

    // Visible, not assumed (issue #105): when did the first card flip
    // interpreted? A log line, not an assert — a cold CI must not flake on
    // the §7 ~10s bar.
    log(
      firstFillMs === null
        ? "first fill: n/a (no card filled this run)"
        : `first fill: ${Math.round(firstFillMs)}ms (spec §7 ~10s bar)`,
    );
  } catch (err) {
    results.push(["smoke crashed", false, String(err)]);
  }

  const pass = results.every(([, ok]) => ok);
  log(
    `${pass ? "✅ PASS" : "❌ FAIL"} — ${results.filter(([, ok]) => ok).length}/${results.length}`,
  );
  for (const [name, ok, detail] of results) {
    log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return { lines };
}
