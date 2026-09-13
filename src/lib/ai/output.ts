/**
 * W3 · AI pipeline core — shared types and the default transport.
 *
 * The structured-output surface (issue #52) lives in records.ts: KV-format
 * record blocks parsed per-record with honest degradation. This module keeps
 * what every AI surface shares:
 *   • the AIResult/AIKind honest-degradation contract,
 *   • the LLMMessage/CallLLM seam types,
 *   • defaultCallLLM — re-exports the AI gateway's transport (issue #53): the
 *     gateway owns the openai-compatible provider, maxRetries: 0, retry and
 *     cooldowns; the app orchestrator and generateRecords (records.ts,
 *     issue #52) both start from exactly this transport (issue #37).
 */

import { callLLM } from './gateway';
import type { ProviderConfig } from './provider';

/** Honest-degradation contract: never throw on an LLM failure. */
export type AIResult<T> =
  { ok: true; result: T } | { ok: false; kind: AIKind; message: string };

export type AIKind =
  | "no_key"
  | "unreachable"
  | "schema_failure"
  | "timeout"
  | "invalid_request"
  | "browser_blocked"
  // A 429 is the endpoint answering "slow down" — reachable, not down
  // (spec §2 never-lie: a throttled BYOK endpoint must not read "unreachable").
  | "rate_limited";

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

/** Default transport: the AI gateway (issue #53) owns the openai-compatible
 * provider, retry/cooldowns, and fetch; this arm re-exports its non-streaming
 * call so the app keeps ONE injectable transport here.
 * Exported: the app-level investigation orchestrator and generateRecords
 * (records.ts, issue #52) both start from exactly this transport (issue #37). */
export const defaultCallLLM: CallLLM = callLLM;
