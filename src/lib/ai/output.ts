/**
 * W3 · AI pipeline core — shared types and the default transport.
 *
 * The structured-output surface (issue #52) lives in records.ts: KV-format
 * record blocks parsed per-record with honest degradation. This module keeps
 * what every AI surface shares:
 *   • the AIResult/AIKind honest-degradation contract,
 *   • the LLMMessage/CallLLM seam types,
 *   • defaultCallLLM — the one real transport (openai-compatible →
 *     generateText → .text), which the app orchestrator and generateRecords
 *     both start from (issue #37).
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderConfig } from "./provider";

/** Honest-degradation contract: never throw on an LLM failure. */
export type AIResult<T> =
  { ok: true; result: T } | { ok: false; kind: AIKind; message: string };

export type AIKind =
  | "no_key"
  | "unreachable"
  | "schema_failure"
  | "timeout"
  | "invalid_request"
  | "browser_blocked";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallLLMArgs {
  provider: ProviderConfig;
  system?: string;
  messages: LLMMessage[];
  temperature: number;
  signal?: AbortSignal;
}

/** Injectable transport — returns the raw model text. Throws on transport failure. */
export type CallLLM = (args: CallLLMArgs) => Promise<string>;

/** Default transport: resolve provider → openai-compatible → generateText → .text.
 * Exported: the app-level investigation orchestrator and generateRecords
 * (records.ts, issue #52) both start from exactly this transport (issue #37). */
export async function defaultCallLLM({
  provider,
  system,
  messages,
  temperature,
  signal,
}: CallLLMArgs): Promise<string> {
  // Retry/backoff logging for the owner's manual runs: the SDK retries 429s
  // silently — each swallow only shows up as unexplained wall time in the
  // records.ts lane. Wrap fetch to log the addressable-but-throttled
  // responses. Only statuses are logged; body content and the
  // Authorization header are never copied (spec §2, ADR-018).
  const lane = provider.name ?? "default";
  const loggedFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      console.debug(
        `[ai:${lane}]    429${retryAfter ? ` retry-after=${retryAfter}s` : ""} — SDK backoff retry coming`,
      );
    }
    return res;
  };
  const p = createOpenAICompatible({
    baseURL: provider.baseUrl,
    name: provider.name,
    apiKey: provider.apiKey,
    fetch: loggedFetch,
  });
  const t0 = Date.now();
  const result = await generateText(
    {
      model: p(provider.model),
      system,
      messages,
      temperature,
      abortSignal: signal,
    },
  );
  console.debug(`[ai:${lane}]    done in ${Date.now() - t0}ms`);
  return result.text;
}
