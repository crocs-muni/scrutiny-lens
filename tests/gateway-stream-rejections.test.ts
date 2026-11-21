// Regression — no AI SDK result rejection may escape the stream transport.
//
// The failure it pins: when a streamed fill attempt dies before its first
// step completes (the harness's 429 and 5xx fill lanes), the SDK rejects its
// own result promises. Its internal markPromiseAsHandled covers the BASE
// promises only, so a promise derived from them inherits the rejection with
// no owner, and Chromium reports it as an unhandled pageerror
// (AI_NoOutputGeneratedError, "No output generated. Check the stream for
// errors.") — while the lane's banner and raw fallback settle correctly.
// The gateway therefore observes the result's promises at creation, and runs
// the lane with the SDK's telemetry scaffolding off (measured in Chromium
// against AI SDK 7.0.79: the pageerror is present with the scaffolding on
// and absent with it off).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ai from 'ai';
import { GatewayError, resetGateway, setBaseFetch, setLimits, streamLLM } from '$lib/ai/gateway';
import type { CallLLMArgs } from '$lib/ai/output';

vi.mock('ai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ai')>();
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

/** OpenAI-compatible SSE frames with the mandatory finish chunk. */
function sseResponse(chunks: readonly string[]): Response {
	const enc = new TextEncoder();
	const frame = (payload: Record<string, unknown>): Uint8Array =>
		enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const content of chunks) {
				controller.enqueue(
					frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }] })
				);
			}
			controller.enqueue(
				frame({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
			);
			controller.enqueue(enc.encode('data: [DONE]' + '\n\n'));
			controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Step {
	/** HTTP status for a JSON answer; default 500 (the doomed lane). */
	status?: number;
	/** text chunks for a 200 SSE stream. */
	stream?: string[];
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
	// The SDK hands the provider a FetchFunction; only the Response matters here.
	return doFetch as unknown as typeof fetch;
}

/** The options the gateway passes streamText. */
interface StreamTextOptions {
	telemetry?: { isEnabled?: boolean };
}

/** vitest's mock over the SDK's generic streamText, narrowed to the surface
 * this suite touches: the recorded options and handing back a shaped result.
 * (The SDK's result generics stay out of the test.) */
const streamTextSpy = vi.mocked(ai.streamText) as unknown as {
	mockClear: () => void;
	mockReturnValueOnce: (value: unknown) => void;
	mock: { calls: ReadonlyArray<readonly [StreamTextOptions]> };
};

/** The options the gateway actually called streamText with. */
function lastStreamTextOptions(): StreamTextOptions {
	const call = streamTextSpy.mock.calls.at(-1);
	if (call === undefined) throw new Error('streamText was never called');
	return call[0];
}

describe('streamLLM — SDK result rejections never escape the transport', () => {
	beforeEach(() => {
		resetGateway();
		streamTextSpy.mockClear();
		setLimits({ maxAttempts: 1, timeoutMs: 2000, inactivityTimeoutMs: 2000 });
	});

	afterEach(() => {
		resetGateway();
		setBaseFetch(undefined);
	});

	it('observes the result promises a doomed attempt rejects', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		/** Deferred rejections released after the stream is drained, when the
		 * SDK's flush would reject its result promises. No timer: the test owns
		 * the moment, so there is no race with the gateway's observation. */
		const pendingRejects: Array<() => void> = [];
		const rejected = (): { promise: Promise<never> } => {
			const { promise, reject } = Promise.withResolvers<never>();
			pendingRejects.push(() =>
				reject(new Error('No output generated. Check the stream for errors.'))
			);
			return { promise };
		};
		// A streamText result shaped like the SDK's doomed-arm one: the stream
		// ends with no part, and the private result promises reject after the
		// gateway has attached its observers. Without the observation, Node
		// reports all four as unhandled rejections (and Chromium as pageerrors).
		const doomed = {
			fullStream: {
				async *[Symbol.asyncIterator](): AsyncGenerator<never> {
					/* a doomed attempt yields no part */
				}
			},
			_steps: rejected(),
			_totalUsage: rejected(),
			_finishReason: rejected(),
			_initialResponseMessages: rejected()
		};
		streamTextSpy.mockReturnValueOnce(doomed);
		process.on('unhandledRejection', onUnhandled);
		try {
			for await (const _ of streamLLM(args())) {
				/* nothing: the attempt produced no text */
			}
			// The SDK's flush rejects its result promises after the stream ends;
			// the gateway has already observed them, so no unhandled event fires.
			for (const reject of pendingRejects) reject();
			for (let turn = 0; turn < 2; turn++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		expect(unhandled).toEqual([]);
	});

	it('still streams every delta with the SDK telemetry scaffolding off', async () => {
		setBaseFetch(scriptedFetch([{ stream: ['he', 'llo'] }]));
		const chunks: string[] = [];
		for await (const chunk of streamLLM(args())) chunks.push(chunk);

		expect(chunks.join('')).toBe('hello');
		// Pinned in Chromium against AI SDK 7.0.79: with the scaffolding on,
		// the doomed lane derives a tracing-completion promise that rejects
		// unowned (the pageerror this file exists for).
		expect(lastStreamTextOptions().telemetry).toEqual({ isEnabled: false });
	});

	it('surfaces the honest GatewayError when the attempt exhausts', async () => {
		setBaseFetch(scriptedFetch([{ status: 500 }]));
		const drain = async (): Promise<string[]> => {
			const chunks: string[] = [];
			for await (const chunk of streamLLM(args())) chunks.push(chunk);
			return chunks;
		};

		await expect(drain()).rejects.toBeInstanceOf(GatewayError);
		expect(lastStreamTextOptions().telemetry).toEqual({ isEnabled: false });
	});
});

