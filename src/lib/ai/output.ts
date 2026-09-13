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
  const p = createOpenAICompatible({
    baseURL: provider.baseUrl,
    name: provider.name,
    apiKey: provider.apiKey,
  });
  const result = await generateText({
    model: p(provider.model),
    system,
    messages,
    temperature,
    abortSignal: signal,
  });
  return result.text;
}
