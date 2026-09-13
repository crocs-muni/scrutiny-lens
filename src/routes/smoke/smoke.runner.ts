/**
 * The smoke run itself (issue #54) — dynamically imported by the dev-only
 * route, so none of these imports enter other routes' graphs or prod builds.
 *
 * Drives the REAL pipeline (translateQuestion + fillCards via defaultCallLLM)
 * against the same-origin fake gateway (scripts/smoke-gateway.ts), whose
 * scripted lanes are keyed by model name. Checks the invariants:
 *   1. every card is interpreted OR honestly raw (no fabricated text)
 *   2. ≥1 card AI-interpreted (the happy path works)
 *   3. no api-key fragment anywhere in the output
 *   4. zero transport failures surfaced (the 429s were retried away)
 *   5. the truncated lane salvaged per-card, not all-or-nothing
 */
import { translateQuestion } from "$lib/ai/agents/query";
import { fillCards, type ProductCard } from "$lib/pipeline/cards";
import { defaultCallLLM } from "$lib/ai/output";

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
      "translate: ≥1 AI search (the 429 was retried away)",
      okTranslate,
      t.ok ? JSON.stringify(t.result.searches) : `${t.kind}: ${t.message}`,
    ]);

    // ── 2. fill lanes: 6 cards in two chunks of 3 ─────────────────
    const cards = [0, 1, 2, 3, 4, 5].map(mkCard);
    const failures: string[] = [];
    const filledAll: ProductCard[] = [];
    // Chunk A rides the degradation gauntlet (429 → junk → truncated);
    // chunk B completes. spread: fillCards returns an array.
    filledAll.push(
      ...(await fillCards(cards.slice(0, 3), {
        provider: provider("smoke-fill-a"),
        callLLM: defaultCallLLM,
        onFailure: (kind) => failures.push(kind),
      })),
      ...(await fillCards(cards.slice(3, 6), {
        provider: provider("smoke-fill-b"),
        callLLM: defaultCallLLM,
        onFailure: (kind) => failures.push(kind),
      })),
    );

    // invariant: every card interpreted or honestly raw (the raw title
    // is the deterministic identifier fallback, never fabricated).
    const allSettled = filledAll.every(
      (c) => c.interpreted || c.title === `BSI-DSZ-CC-000${c.id.slice(6)}`,
    );
    results.push([
      "fill: every card interpreted-or-honestly-raw",
      allSettled,
      filledAll.map((c) => `${c.id}:${c.interpreted ? "AI" : "raw"}`).join(" "),
    ]);

    const anyFilled = filledAll.some((c) => c.interpreted);
    results.push([
      "fill: ≥1 card AI-interpreted (the happy path works)",
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

    // The 429 must have been retried away: no transport-kind failure surfaced.
    const transportFailures = failures.filter(
      (f) => f === "unreachable" || f === "timeout" || f === "browser_blocked",
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
      chunkA.map((c) => (c.interpreted ? "AI" : "raw")).join(" "),
    ]);

    // Chunk B fully interpreted.
    const chunkB = filledAll.slice(3, 6);
    results.push([
      "fill: complete chunk fully interpreted",
      chunkB.every((c) => c.interpreted),
      chunkB.map((c) => (c.interpreted ? "AI" : "raw")).join(" "),
    ]);
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
