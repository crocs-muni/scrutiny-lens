// Fill-lane verdicts for the card-fill surface (spec §6 deterministic wording).
// Pure and store-free on purpose: importing these must not drag the
// investigation store (IndexedDB, relays) into every caller or test.

import type { AIKind } from "$lib/ai/output";

/** Fill-failure recording rule, exported for the ordering pin: schema_failure
 * and rate_limited are sticky — a later transport error can't overwrite "the
 * AI was reachable" (spec §2 never-lie). The message obeys the same priority:
 * only the WINNING kind may pair its reason, else the banner could show an
 * unreachable-flavored message under a schema_failure/rate_limited kind. */
export function recordFillFailure(
  target: { fillFailure: AIKind | null; fillErrorMessage: string | null },
  kind: AIKind,
  message?: string,
): void {
  if (target.fillFailure === "schema_failure" || target.fillFailure === "rate_limited") return;
  target.fillFailure = kind;
  if (typeof message === "string") {
    target.fillErrorMessage = message.length > 140 ? message.slice(0, 139) + "…" : message;
  }
}

/**
 * Results-surface banner text for the card-fill lane (spec §6 deterministic
 * wording — never AI-written). Distinguishes a dead endpoint (unreachable/
 * timeout), one blocked by the browser before any HTTP response (browser_blocked
 * — CORS preflight / mixed content, spec §2), one throttling us (rate_limited
 * — a 429 IS an answer: the endpoint is up, just asking us to slow down), and
 * one that answered but produced non-conforming output (schema_failure): the
 * last two must not be mislabeled "Endpoint unreachable" (spec §2 never-lie — in the
 * owner's incident the endpoint WAS reachable), and a browser block must not
 * claim the endpoint is down. User-visible text speaks issue #108's
 * raw/filled vocabulary — never "AI" or "interpreted".
 */
export function fillNote(
  interpreted: number,
  total: number,
  failure: AIKind | null,
  message: string | null = null,
  /** 429s the gateway saw during this run (issue #105). Rides as a
   * trailing suffix so #108's rewording of the head sentence leaves it
   * intact; 0 = the retries cleared everything, nothing to add. */
  rateLimitedCount = 0,
): string {
  if (total <= 0 || interpreted >= total) return "";
  if (interpreted > 0) {
    return `Slow — ${interpreted} of ${total} cards filled · the rest show the raw events`;
  }
  const reason = message === null || message === "" ? "" : ` (${message})`;
  if (failure === "schema_failure") {
    return `Output didn't conform${reason} — cards show the raw events`;
  }
  if (failure === "rate_limited") {
    const countSuffix = rateLimitedCount > 0 ? ` · endpoint rate limited ${rateLimitedCount}×` : "";
    return `Endpoint rate limited — cards show the raw events${countSuffix}`;
  }
  if (failure === "browser_blocked") {
    return "Endpoint blocked by the browser (CORS or mixed content) — cards show the raw events";
  }
  return `Endpoint unreachable${reason} — cards show the raw events`;
}
