/**
 * C3 · Live array-structured-output smoke test.
 *
 * Makes real calls to the env-configured endpoint (API_KEY/BASE_URL/MODEL from
 * .env) at temp 0.2 and answers "does batched structured output work on our
 * models" two ways:
 *
 *   A. SDK strict path: `generateText({ output: Output.array({ element }) })` —
 *      asks the provider for a schema-enforced JSON array (needs
 *      structuredOutputs support). Reports HTTP status, parseable?,
 *      all-fields-present?, model, latency.
 *   B. Plain-text path (what src/lib/server/ai/output.ts actually does): ask
 *      for a JSON array as free text, then JSON.parse + zod-gate it ourselves.
 *
 * Reports raw results for both. If API_KEY is absent prints a SKIP marker and
 * exits 0 (the contract's graceful path — this ships OFFLINE-safe).
 *
 * Run: node scripts/c3-array-smoke.mts   (Node ≥24 strips TS natively)
 */

import { readFileSync } from 'node:fs';
import { generateText, Output } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

function loadEnv(): Record<string, string> {
	try {
		const text = readFileSync('.env', 'utf8');
		const out: Record<string, string> = {};
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (m) out[m[1]] = m[2];
		}
		return out;
	} catch {
		return {};
	}
}

const env = loadEnv();
const API_KEY = env.API_KEY;
const BASE_URL = env.BASE_URL ?? 'https://llm.ai.e-infra.cz/v1';
const MODEL = env.MODEL ?? 'coder';

if (!API_KEY) {
	console.log('SKIP: API_KEY not present in .env — no live structured-output check performed.');
	process.exit(0);
}

const elementSchema = z.object({
	id: z.string(),
	name: z.string(),
	kind: z.string(),
	vendor: z.string(),
	scheme: z.string(),
	assurance: z.string(),
	status: z.string(),
	summary: z.string().max(200)
});

const FIELDS = ['id', 'name', 'kind', 'vendor', 'scheme', 'assurance', 'status', 'summary'];

let lastStatus: number | null = null;
const wrappedFetch: typeof fetch = (input, init) =>
	fetch(input, init).then((res) => {
		lastStatus = res.status;
		return res;
	});

const provider = createOpenAICompatible({ baseURL: BASE_URL, name: 'c3-smoke', apiKey: API_KEY, fetch: wrappedFetch });

const ARRAY_PROMPT =
	'Return exactly 2 JSON objects for two Common-Criteria certified products (e.g. a smartcard and a secure microcontroller). Each object has fields: id, name, kind, vendor, scheme, assurance, status, summary (summary ≤ 180 chars of natural English prose). Respond with ONLY a JSON array; no prose, no markdown fences.';

function allFieldsPresent(array: unknown[]): boolean {
	return array.every((o) => FIELDS.every((k) => typeof (o as Record<string, unknown>)[k] === 'string'));
}

function report(label: string, meta: Record<string, unknown>, raw?: unknown): void {
	console.log(`C3_${label}_RESULT`);
	console.log(JSON.stringify(raw, null, 2));
	console.log(`C3_${label}_META`);
	console.log(JSON.stringify(meta, null, 2));
}

async function main(): Promise<void> {
	// ── A. SDK strict structured-output path ─────────────────────────────────────
	{
		const started = performance.now();
		try {
			const result = await generateText({
				model: provider(MODEL),
				temperature: 0.2,
				system: 'You are a structured-data assistant. Respond ONLY with a JSON array matching the requested schema.',
				prompt: ARRAY_PROMPT,
				output: Output.array({ element: elementSchema, name: 'products' })
			});
			const array = result.output as Array<z.infer<typeof elementSchema>>;
			report(
				'A_STRICT_ARRAY',
				{
					httpStatus: lastStatus,
					parseable: true,
					allFieldsPresent: allFieldsPresent(array),
					model: result.response?.modelId ?? MODEL,
					latencyMs: Math.round(performance.now() - started),
					finishReason: result.finishReason
				},
				{ count: array.length, items: array }
			);
		} catch (err) {
			report(
				'A_STRICT_ARRAY',
				{
					httpStatus: lastStatus,
					parseable: false,
					allFieldsPresent: false,
					model: MODEL,
					latencyMs: Math.round(performance.now() - started),
					error: String(err)
				},
				{ kind: 'error' }
			);
		}
	}

	// ── B. Plain-text path (what src/lib/server/ai/output.ts does) ──────────────
	{
		const started = performance.now();
		try {
			const result = await generateText({
				model: provider(MODEL),
				temperature: 0.2,
				system: 'You are a structured-data assistant. Respond with ONLY a JSON array; no prose, no markdown fences.',
				prompt: ARRAY_PROMPT
			});
			const text = result.text;
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				report(
					'B_PLAIN_ARRAY',
					{
						httpStatus: lastStatus,
						parseable: false,
						allFieldsPresent: false,
						model: result.response?.modelId ?? MODEL,
						latencyMs: Math.round(performance.now() - started),
						finishReason: result.finishReason,
						note: 'response text was not parseable JSON'
					},
					{ text }
				);
				process.exitCode = 1;
			}
			if (parsed !== undefined) {
				const zod = z.array(elementSchema).safeParse(parsed);
				report(
					'B_PLAIN_ARRAY',
					{
						httpStatus: lastStatus,
						parseable: zod.success,
						allFieldsPresent: zod.success ? allFieldsPresent(zod.data) : false,
						model: result.response?.modelId ?? MODEL,
						latencyMs: Math.round(performance.now() - started),
						finishReason: result.finishReason,
						zodValid: zod.success
					},
					{ count: zod.success ? zod.data.length : null, items: parsed }
				);
				if (!zod.success) process.exitCode = 1;
			}
		} catch (err) {
			report(
				'B_PLAIN_ARRAY',
				{
					httpStatus: lastStatus,
					parseable: false,
					allFieldsPresent: false,
					model: MODEL,
					latencyMs: Math.round(performance.now() - started),
					error: String(err)
				},
				{ kind: 'error' }
			);
			process.exitCode = 1;
		}
	}
}

main();
