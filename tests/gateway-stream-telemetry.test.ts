// Regression — the streaming lane runs with the AI SDK's telemetry
// scaffolding switched OFF.
//
// With the SDK default on, `streamText` derives a tracing `completion`
// promise from `_totalUsage.promise`; an attempt that dies before its first
// step rejects it with AI_NoOutputGeneratedError ("No output generated.
// Check the stream for errors.") with no owner. Chromium raises that as a
// pageerror while the fill lane's banner and raw fallback settle correctly.
// Measured in Chromium against AI SDK 7.0.79: pageerror present with the
// scaffolding on, absent with `telemetry: { isEnabled: false }`. The harness
// scenes results-fill-429 / results-ai-down are the behavioural pin; this
// suite keeps the option from being removed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ai from 'ai';
import { GatewayError, resetGateway, setBaseFetch, setLimits, streamLLM } from '$lib/ai/gateway';
import type { CallLLMArgs } from '$lib/ai/output';

vi.mock('ai', async (importOriginal) => {
	const actual = await importOriginal<typeof ai>();
	return { ...actual, streamText: vi.fn(actual.streamText) };
});

const provider = {
	name: 't',
	baseUrl: 'https://api.test/v1',
	model: 'm',
	apiKey: 'regression-key'
};

function args(over: Partial<CallLLMArgs> = {}): CallLLMArgs {
	return {
		provider,
		system: 's',
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
		...over
	};
}

interface Step {
	/** HTTP status for a JSON answer; default 500 (the failing lane). */
	status?: number;
	/** text chunks for a 200 SSE stream. */
	stream?: string[];
}

/** OpenAI-compatible SSE frames with the mandatory finish chunk. */
function sseResponse(chunks: readonly string[]): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const content of chunks) {
				controller.enqueue(
					enc.encode(
						`data: ${JSON.stringify({
							id: 'c1',
							object: 'chat.completion.chunk',
							choices: [{ index: 0, delta: { content } }]
						})}\n\n`
					)
				);
			}
			controller.enqueue(
				enc.encode(
					`data: ${JSON.stringify({
						id: 'c1',
						object: 'chat.completion.chunk',
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
					})}\n\n`
				)
			);
			controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Fail-closed scripted network: an unscripted request throws instead of
 * reaching the live network (same rule as gateway.test.ts). */
function scriptedFetch(steps: readonly Step[]): typeof fetch {
	let next = 0;
	const doFetch = async (): Promise<Response> => {
		const step = steps[next++];
		if (step === undefined) throw new Error(`fail-closed: unexpected fetch #${String(next)}`);
		if (step.stream !== undefined) return sseResponse(step.stream);
		const status = step.status ?? 500;
		return new Response(JSON.stringify({ error: { message: `HTTP ${String(status)}` } }), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	};
	return doFetch as unknown as typeof fetch;
}

interface StreamTextOptions {
	telemetry?: { isEnabled?: boolean };
}

const streamTextSpy = vi.mocked(ai.streamText) as unknown as {
	mockClear: () => void;
	mock: { calls: ReadonlyArray<readonly [StreamTextOptions]> };
};

function lastStreamTextOptions(): StreamTextOptions {
	const call = streamTextSpy.mock.calls.at(-1);
	if (call === undefined) throw new Error('streamText was never called');
	return call[0];
}

describe('streamLLM — SDK telemetry scaffolding is off', () => {
	beforeEach(() => {
		resetGateway();
		streamTextSpy.mockClear();
		setLimits({ maxAttempts: 1, timeoutMs: 2000, inactivityTimeoutMs: 2000 });
	});

	afterEach(() => {
		resetGateway();
		setBaseFetch(undefined);
	});

	it('passes telemetry off and still throws the honest GatewayError', async () => {
		setBaseFetch(scriptedFetch([{ status: 500 }]));
		const drain = async (): Promise<string[]> => {
			const chunks: string[] = [];
			for await (const chunk of streamLLM(args())) chunks.push(chunk);
			return chunks;
		};

		await expect(drain()).rejects.toBeInstanceOf(GatewayError);
		expect(lastStreamTextOptions().telemetry).toEqual({ isEnabled: false });
	});

	it('still streams every delta with telemetry off', async () => {
		setBaseFetch(scriptedFetch([{ stream: ['he', 'llo'] }]));
		const chunks: string[] = [];
		for await (const chunk of streamLLM(args())) chunks.push(chunk);

		expect(chunks.join('')).toBe('hello');
		expect(lastStreamTextOptions().telemetry).toEqual({ isEnabled: false });
	});
});
