/**
 * W3 · AI pipeline core — structured LLM output with honest degradation.
 *
 * ── C1: ai v7 (7.0.79) structured-output API surface (verified against the
 *    installed `node_modules/ai/dist/index.d.ts`) ─────────────────────────────
 *   • `generateText` / `streamText`  — imported from `'ai'` (https://ai-sdk.dev).
 *   • `generateObject` / `streamObject` still exist but are marked
 *     `@deprecated Use generateText with an output setting instead.`
 *   • The recommended surface is `generateText({ ..., output })` where `output`
 *     comes from the `Output` namespace exported by `'ai'`:
 *       Output.object({ schema, name?, description? })  → schema-typed object
 *       Output.array({ element, name?, description? })  → array of elements
 *       Output.text() / Output.choice({ options }) / Output.json()
 *     With an `output` spec the SDK itself parses + validates and returns the
 *     typed value at `result.output` (throws otherwise).
 *   • Provider: `createOpenAICompatible({ baseURL, name, apiKey, fetch? })` from
 *     `'@ai-sdk/openai-compatible'`; call the instance with a model id →
 *     `LanguageModelV4` accepted by `generateText`.
 *
 *   Design note: this module deliberately drives `generateText` in plain-text
 *   mode and performs its OWN JSON + zod gate. Rationale (locked contract):
 *     - the pipeline needs EXACTLY ONE repair-retry that appends the zod error
 *       text to the prompt and then degrades honestly to an `AIResult`;
 *     - the SDK's `Output.object` mode runs its own opaque repair loop and
 *       throws typed errors instead of returning a degraded result, which is
 *       not controllable/deterministic for offline tests.
 *   The `Output.array` surface (C1) is exercised for real in
 *   `scripts/c3-array-smoke.mts` to answer "does batched structured output work
 *   on our models"; the plumbing here can adopt it by swapping the transport.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getProviderConfig, NO_KEY_MESSAGE, type ProviderConfig, type ProviderOverrideInput } from './provider';

/** Honest-degradation contract: never throw on an LLM failure. */
export type AIResult<T> =
	| { ok: true; result: T }
	| { ok: false; kind: AIKind; message: string };

export type AIKind =
	| 'no_key'
	| 'unreachable'
	| 'schema_failure'
	| 'timeout'
	| 'invalid_request';

export interface LLMMessage {
	role: 'user' | 'assistant';
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

export interface GenerateStructuredOptions<T> {
	schema: z.ZodType<T>;
	system?: string;
	messages: LLMMessage[];
	/** Default 0.2 (grill Q5: one small model, temp 0.2 for extraction). */
	temperature?: number;
	abortSignal?: AbortSignal;
	/** BYOK override resolved through provider.ts (ADR-018: apiKey never echoed). */
	provider?: ProviderOverrideInput;
	/** Test seam; defaults to the real generateText transport. */
	callLLM?: CallLLM;
}

/** Default transport: resolve provider → openai-compatible → generateText → .text */
async function defaultCallLLM({ provider, system, messages, temperature, signal }: CallLLMArgs): Promise<string> {
	const p = createOpenAICompatible({
		baseURL: provider.baseUrl,
		name: provider.name,
		apiKey: provider.apiKey
	});
	const result = await generateText({
		model: p(provider.model),
		system,
		messages,
		temperature,
		abortSignal: signal
	});
	return result.text;
}

function isAbort(signal: AbortSignal | undefined, err: unknown): boolean {
	return (
		signal?.aborted === true ||
		(err as { name?: string } | null)?.name === 'AbortError' ||
		(String((err as Error | null)?.message ?? '')
			.toLowerCase()
			.includes('abort'))
	);
}

function kindOf(err: unknown): AIKind {
	const status = (err as { statusCode?: number } | null)?.statusCode;
	if (status !== undefined) {
		return status >= 300 && status < 500 ? 'invalid_request' : 'unreachable';
	}
	const msg = String((err as Error | null)?.message ?? err).toLowerCase();
	if (/timeout|timed out|etimedout|deadline/i.test(msg)) return 'timeout';
	return 'unreachable';
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function parseResult<T>(schema: z.ZodType<T>, text: string): ParseOutcome<T> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return { ok: false, issues: [`response is not valid JSON: ${(e as Error).message}`] };
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.error.issues.map(
				(i) => `${i.path.join('.') || '(root)'}: ${i.message}`
			)
		};
	}
	return { ok: true, value: parsed.data };
}

async function attempt<T>(
	call: CallLLM,
	args: CallLLMArgs
): Promise<{ kind: 'ok'; text: string } | { kind: 'err'; kindOf: AIKind; message: string }> {
	try {
		const text = await call(args);
		return { kind: 'ok', text };
	} catch (err) {
		if (isAbort(args.signal, err)) throw err; // propagate caller cancellation
		return { kind: 'err', kindOf: kindOf(err), message: String((err as Error)?.message ?? err) };
	}
}

/**
 * Generate a single structured value from a prompt, zod-gated at our boundary,
 * with exactly ONE repair-retry that appends the validation issue text, then
 * degrades honestly. Never throws on LLM failure (abort is propagated).
 */
export async function generateStructured<T>(opts: GenerateStructuredOptions<T>): Promise<AIResult<T>> {
	const { schema, system, messages, temperature = 0.2, abortSignal, provider, callLLM } = opts;

	const provRes = getProviderConfig(provider);
	if (!provRes.ok) {
		return provRes.kind === 'no_key'
			? { ok: false, kind: 'no_key', message: NO_KEY_MESSAGE }
			: { ok: false, kind: 'invalid_request', message: provRes.issues.join('; ') };
	}

	const call = callLLM ?? defaultCallLLM;
	const base: CallLLMArgs = { provider: provRes.config, system, messages, temperature, signal: abortSignal };

	const first = await attempt(call, base);
	if (first.kind === 'err') return { ok: false, kind: first.kindOf, message: first.message };

	const parsed = parseResult(schema, first.text);
	if (parsed.ok) return { ok: true, result: parsed.value };

	// Exactly one repair retry: append the zod issue text to the prompt.
	const retryPrompt: LLMMessage[] = [
		...messages,
		{
			role: 'user',
			content: `Your previous response failed validation:\n${parsed.issues.join('\n')}\n\nReturn JSON matching the schema.`
		}
	];

	const second = await attempt(call, { ...base, messages: retryPrompt });
	if (second.kind === 'err') return { ok: false, kind: second.kindOf, message: second.message };

	const reparsed = parseResult(schema, second.text);
	if (reparsed.ok) return { ok: true, result: reparsed.value };

	return {
		ok: false,
		kind: 'schema_failure',
		message: `Response failed schema validation after one repair. ${reparsed.issues.join(' ')}`
	};
}
