// W53 · AI gateway tests — the transport trust gate (issue #53).
//
// The fake fetch is FAIL-CLOSED: any request not matching the script throws
// (the simonw/llm#1608 lesson — a transport mock that silently falls through
// to the live network mutes real failures). Everything here runs through the
// REAL SDK provider (createOpenAICompatible with our injected fetch), so
// headers, JSON encoding, and error mapping run for real; only the network is
// scripted.
//
// Real wall-clock timers are deliberate in this suite: the gateway's
// semaphore, cooldowns, and backoff sleeps ARE the behavior under test and
// interplay with AbortSignal.timeout/fetch in ways fake timers cannot drive
// deterministically here. Durations are kept small (≤1s).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	callLLM,
	streamLLM,
	GatewayError,
	resetGateway,
	setBaseFetch,
	setLimits,
	primeSecrets,
	scrubSecrets
} from '$lib/ai/gateway';
import { generateRecords } from '$lib/ai/records';
import { fetchModels } from '$lib/ai/models';
import type { CallLLMArgs } from '$lib/ai/output';

const KEY = 'supersecretkey123';
const provider = { name: 't', baseUrl: 'https://api.test/v1', model: 'm', apiKey: KEY };

function args(over: Partial<CallLLMArgs> = {}): CallLLMArgs {
	return {
		provider,
		system: 's',
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
		...over
	};
}

function abortOf(signal?: AbortSignal): unknown {
	return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Delay that settles early (rejected) when the signal aborts — mirrors real
 * fetch fidelity so abort tests measure the gateway, not the fake. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal?.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	(timer as { unref?: () => void }).unref?.();
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(abortOf(signal));
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
		reject(abortOf(signal));
	}
	return promise;
}
/** Poll until `fn` is truthy (real timers) — removes wall-clock races the
 * suite would otherwise carry on loaded event loops. */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
		await delay(2);
	}
}

/* ------------------------------------------------------------------ *
 * Scripted fail-closed fetch
 * ------------------------------------------------------------------ */

interface Step {
	/** HTTP status; default 200 */
	status?: number;
	headers?: Record<string, string>;
	/** body for a JSON response */
	body?: unknown;
	/** SSE text chunks for a 200 stream */
	stream?: string[];
	/** ms to delay the response start (abort-aware) */
	delayMs?: number;
	/** ms to delay BETWEEN stream chunks (after the first) */
	chunkGapMs?: number;
	/** never resolve; reject when the request signal aborts */
	hang?: true;
}

interface FetchLog {
	url: string;
	startMs: number;
	headers: Record<string, string>;
	signal?: AbortSignal;
}

function chatCompletion(text: string) {
	return {
		id: 'c1',
		object: 'chat.completion',
		created: 1,
		model: 'm',
		choices: [
			{
				index: 0,
				message: { role: 'assistant' as const, content: text },
				finish_reason: 'stop' as const
			}
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
	};
}

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** SSE stream. A final finish_reason chunk is REQUIRED — without it the SDK
 * ends the stream with InvalidResponseDataError (verified against
 * @ai-sdk/openai-compatible). */
function sseResponse(chunks: string[], gapMs = 0): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (let i = 0; i < chunks.length; i++) {
				if (i > 0 && gapMs > 0) await delay(gapMs);
				controller.enqueue(
					enc.encode(
						sseChunk({
							id: 'c1',
							object: 'chat.completion.chunk',
							choices: [{ index: 0, delta: { content: chunks[i] } }]
						})
					)
				);
			}
			controller.enqueue(
				enc.encode(
					sseChunk({
						id: 'c1',
						object: 'chat.completion.chunk',
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
					})
				)
			);
			controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Scripted, fail-closed fetch. Each request shifts one step; a missing step
 * throws (never hits a live network). */
function scriptedFetch(steps: Step[]): { fetch: typeof fetch; log: FetchLog[] } {
	const log: FetchLog[] = [];
	let next = 0;
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		const step = steps[next++];
		if (step === undefined) {
			throw new Error(`fail-closed: unexpected fetch #${next} to ${url}`);
		}
		log.push({
			url,
			startMs: Date.now(),
			headers: (init?.headers as Record<string, string>) ?? {},
			signal: init?.signal ?? undefined
		});
		if (step.delayMs) await delay(step.delayMs, init?.signal ?? undefined);
		if (step.hang) {
			// Simulates a request that never settles until the SDK aborts it.
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener('abort', () => reject(abortOf(init.signal ?? undefined)), { once: true });
			return promise;
		}
		if (step.stream) return sseResponse(step.stream, step.chunkGapMs ?? 0);
		const status = step.status ?? 200;
		const body =
			step.body !== undefined
				? JSON.stringify(step.body)
				: status >= 300
					? JSON.stringify({
							error: { message: `HTTP ${status} for api_key: ${KEY}`, type: 'x', code: status }
						})
					: JSON.stringify(chatCompletion('T'));
		return new Response(body, { status, headers: { 'content-type': 'application/json', ...step.headers } });
	};
	return { fetch: doFetch as unknown as typeof fetch, log };
}

/** 429 step carrying the LiteLLM-shaped body that leaks the key hash. */
function rateLimited(retryAfterSecs: string): Step {
	return {
		status: 429,
		headers: { 'retry-after': retryAfterSecs },
		body: {
			error: { message: `Rate limit exceeded for api_key: ${KEY}`, type: 'rate_limit_error', code: '429' }
		}
	};
}

/** Wraps a scripted fetch with in-flight peak tracking. */
function withPeak(f: typeof fetch): { fetch: typeof fetch; peak: () => number } {
	let active = 0;
	let peak = 0;
	const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		active += 1;
		peak = Math.max(peak, active);
		try {
			return await f(input, init);
		} finally {
			active -= 1;
		}
	};
	return { fetch: wrapped as unknown as typeof fetch, peak: () => peak };
}

/** Two scripted endpoints routed by URL — one endpoint's script must never
 * answer another's (they share the cap under test). */
function routedFetch(
	a: { fetch: typeof fetch },
	b: { fetch: typeof fetch },
	bPrefix: string
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		return url.startsWith(bPrefix) ? b.fetch(input, init) : a.fetch(input, init);
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	resetGateway();
	setBaseFetch(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Semaphore
 * ------------------------------------------------------------------ */

describe('concurrency cap', () => {
	it('peak respects maxConcurrent=2 across 20 calls; FIFO admission matches issue order (asserted by call identity)', async () => {
		// Each call carries a UNIQUE apiKey; the SDK forwards it as
		// `authorization: Bearer <key>` (lowercased header name), so the fetch
		// log's header order IS the admission order — a monotone startMs
		// assertion passes under LIFO too, which is why identity is asserted.
		const tags = Array.from({ length: 20 }, (_, i) => `${KEY}:slot${i}`);
		// Pre-prime the key digests so every call hits the cache synchronously
		// and reaches acquire() in strict launch order.
		await Promise.all(tags.map((k) => primeSecrets(k)));
		const { fetch: f, log } = scriptedFetch(Array.from({ length: 20 }, () => ({ delayMs: 60 })));
		const { fetch: tracked, peak } = withPeak(f);
		setBaseFetch(tracked);
		const results = await Promise.all(
			tags.map((apiKey) => callLLM(args({ provider: { ...provider, apiKey } })))
		);
		expect(results).toHaveLength(20);
		expect(peak()).toBe(2);
		expect(log).toHaveLength(20);
		expect(log.map((l) => l.headers['authorization'])).toEqual(tags.map((k) => `Bearer ${k}`));
	});
});

/* ------------------------------------------------------------------ *
 * Adaptive pacing (issue #64): the per-baseUrl window shrinks on 429 and
 * recovers toward the static cap after a clean window of successes.
 * ------------------------------------------------------------------ */

describe('adaptive pacing (issue #64)', () => {
	it('shrinks the baseUrl window after a 429: the next burst admits half as many in-flight', async () => {
		// A 429 is the endpoint's own "too many" vote — the gateway must shrink
		// the admitted-in-flight window for that baseUrl, not just cool down
		// and burst again the same size (spec §2: the limit is a concurrency
		// ceiling, not a rate ceiling — the owner's logs show storms of them).
		// One call: attempt 1 → 429, Retry-After honored → attempt 2 succeeds.
		const first = scriptedFetch([rateLimited('0'), {}]);
		setBaseFetch(first.fetch);
		await expect(callLLM(args())).resolves.toBe('T');

		// Window before: 2 (the static cap). After the 429: halved to 1.
		// A fresh burst of 4 calls must now admit ONE at a time, not two.
		const burst = scriptedFetch(Array.from({ length: 4 }, () => ({ delayMs: 60 })));
		const { fetch: tracked, peak } = withPeak(burst.fetch);
		setBaseFetch(tracked);
		await Promise.all(Array.from({ length: 4 }, () => callLLM(args())));
		expect(peak()).toBe(1);
	});

	it('recovers toward the cap after a clean window of K consecutive successes', async () => {
		// Same halve first: window = 1, clean-streak = 1 after the retry success.
		const first = scriptedFetch([rateLimited('0'), {}]);
		setBaseFetch(first.fetch);
		await expect(callLLM(args())).resolves.toBe('T');

		// A 2-call burst while the streak is still short of K (1 + 2 = 3 < 4):
		// window must stay at 1 — the second call waits for the first's slot.
		// (Exact-K pin: growth must NOT fire on the second burst call, or a
		// 2-call burst would see two slots and peak 2.)
		const smallBurst = scriptedFetch(Array.from({ length: 2 }, () => ({ delayMs: 40 })));
		const small = withPeak(smallBurst.fetch);
		setBaseFetch(small.fetch);
		await Promise.all(Array.from({ length: 2 }, () => callLLM(args())));
		expect(small.peak()).toBe(1);

		// One more clean success reaches K=4 on this baseUrl (1 + 2 + 1):
		// the window grows back by one. The same burst now admits two.
		const grow = scriptedFetch([{}]);
		setBaseFetch(grow.fetch);
		await expect(callLLM(args())).resolves.toBe('T');
		const bigBurst = scriptedFetch(Array.from({ length: 4 }, () => ({ delayMs: 40 })));
		const big = withPeak(bigBurst.fetch);
		setBaseFetch(big.fetch);
		await Promise.all(Array.from({ length: 4 }, () => callLLM(args())));
		expect(big.peak()).toBe(2);
	});
});

/* ------------------------------------------------------------------ *
 * 429 handling
 * ------------------------------------------------------------------ */

describe('429 + Retry-After', () => {
	it('waits the Retry-After window, then succeeds', async () => {
		const { fetch: f, log } = scriptedFetch([rateLimited('1'), {}]);
		setBaseFetch(f);
		expect(await callLLM(args())).toBe('T');
		expect(log).toHaveLength(2);
		// Retry-After 1s, jitter only widens (never below the stated value).
		expect(log[1].startMs - log[0].startMs).toBeGreaterThanOrEqual(950);
	});

	it('sole retry layer: exactly maxAttempts fetches on persistent 429; kind rate_limited; message carries 429 but not the key', async () => {
		const { fetch: f, log } = scriptedFetch([
			rateLimited('0'),
			rateLimited('0'),
			rateLimited('0'),
			rateLimited('0')
		]);
		setBaseFetch(f);
		const res = await generateRecords({
			schema: z.object({ t: z.string() }),
			knownKeys: ['t'],
			messages: [{ role: 'user', content: 'hi' }],
			provider
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			// A 429 is a quota fact, surfaced honestly as rate-limited-with-reason
			// (spec §2), never conflated with a dead endpoint or an invalid
			// request — and never with the key (ADR-018).
			expect(res.kind).toBe('rate_limited');
			expect(res.message).not.toContain(KEY);
			expect(res.message).toContain('429');
		}
		// SDK-internal retry is OFF (maxRetries: 0): 3 attempts total, not 9.
		expect(log).toHaveLength(3);
	});

	it('honors Retry-After as HTTP-date', async () => {
		// HTTP-date is second-precision: the parsed value lands in
		// [floor(second), second] — 3s out gives a 1.5s floor after any
		// transport skew (jitter only widens).
		const httpDate = new Date(Date.now() + 3000).toUTCString();
		const { fetch: f, log } = scriptedFetch([{ status: 429, headers: { 'retry-after': httpDate } }, {}]);
		setBaseFetch(f);
		await callLLM(args());
		expect(log).toHaveLength(2);
		expect(log[1].startMs - log[0].startMs).toBeGreaterThanOrEqual(1500);
	});

	it('sets a cooldown for the baseUrl while a different baseUrl proceeds immediately', async () => {
		const a = scriptedFetch([rateLimited('1'), {}]);
		const b = scriptedFetch([{ delayMs: 10 }]);
		setBaseFetch(routedFetch(a, b, 'https://other.test'));
		const other = { ...provider, baseUrl: 'https://other.test/v1' };
		const slow = callLLM(args()); // 429 → ~1s cooldown → retry succeeds
		await delay(30);
		const t0 = Date.now();
		expect(await callLLM(args({ provider: other }))).toBe('T');
		expect(Date.now() - t0).toBeLessThan(500);
		await slow;
		expect(a.log).toHaveLength(2);
		expect(b.log).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ *
 * Non-retryable statuses, 5xx, aborts, timeout
 * ------------------------------------------------------------------ */

describe('status handling', () => {
	it('401: exactly one fetch, immediate GatewayError with status, scrubbed message', async () => {
		const { fetch: f, log } = scriptedFetch([{ status: 401 }]);
		setBaseFetch(f);
		await expect(callLLM(args())).rejects.toSatisfy((e: unknown) => {
			expect(e).toBeInstanceOf(GatewayError);
			const g = e as GatewayError;
			expect(g.statusCode).toBe(401);
			expect(g.message).not.toContain(KEY);
			return true;
		});
		expect(log).toHaveLength(1);
	});

	it('5xx: per-call backoff, maxAttempts fetches, NO cooldown (next call starts immediately)', async () => {
		const { fetch: f, log } = scriptedFetch([
			{ status: 503 },
			{ status: 503 },
			{ status: 503 },
			{ status: 503 }
		]);
		setBaseFetch(f);
		await expect(callLLM(args())).rejects.toBeInstanceOf(GatewayError);
		expect(log).toHaveLength(3);
		// No global cooldown: a fresh call to the same baseUrl fires at once.
		await expect(callLLM(args())).rejects.toBeInstanceOf(GatewayError);
		expect(log).toHaveLength(4);
	});

	it('aborted waiter never fires a request; other calls proceed', async () => {
		const { fetch: f, log } = scriptedFetch([{ delayMs: 120 }, { delayMs: 120 }, {}]);
		setBaseFetch(f);
		const a = callLLM(args());
		const b = callLLM(args());
		// Wait until BOTH fetches fired: with maxConcurrent=2 that means a and b
		// hold the two slots, so c (created next) is guaranteed to be the queued
		// 3rd call. A blind delay raced the primeSecrets async digest under load.
		await waitFor(() => log.length === 2);
		const controller = new AbortController();
		const c = callLLM(args({ signal: controller.signal }));
		await delay(30);
		controller.abort();
		await expect(c).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
		await a;
		await b;
		expect(log).toHaveLength(2); // c never reached the network
	});

	it('caller abort on a hanging fetch: one AbortError, never retried, slot released', async () => {
		const { fetch: f, log } = scriptedFetch([{ hang: true }, {}]);
		setBaseFetch(f);
		const controller = new AbortController();
		const p = callLLM(args({ signal: controller.signal }));
		await waitFor(() => log.length === 1);
		controller.abort();
		await expect(p).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
		expect(log).toHaveLength(1);
		// Slot was released: a fresh call must not wait on the aborted lane.
		const t0 = Date.now();
		expect(await callLLM(args())).toBe('T');
		expect(Date.now() - t0).toBeLessThan(1000);
	});

	it('caller abort mid-flight rejects immediately with AbortError', async () => {
		const { fetch: f } = scriptedFetch([{ delayMs: 500 }]);
		setBaseFetch(f);
		const controller = new AbortController();
		const p = callLLM(args({ signal: controller.signal }));
		setTimeout(() => controller.abort(), 50);
		await expect(p).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
	});
});

/* ------------------------------------------------------------------ *
 * Scrub (ADR-018)
 * ------------------------------------------------------------------ */

describe('scrubSecrets', () => {
	it('redacts raw key, JSON-escaped key, sha256 hex, and labeled tokens', async () => {
		await primeSecrets(KEY);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY));
		const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
		const escaped = JSON.stringify(KEY).slice(1, -1);

		const cases = [
			`boom ${KEY}`,
			`boom ${escaped}`,
			`Rate limit exceeded for api_key: ${hash}`,
			`Rate limit exceeded for api_key: ${hash.slice(0, 11)}…`,
			`Authorization: Bearer ${KEY}`
		];
		for (const text of cases) {
			const out = scrubSecrets(text, KEY);
			expect(out).not.toContain(KEY);
			expect(out).not.toContain(hash.slice(0, 11));
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it('does not shred ordinary text for a short key', () => {
		const text = 'the quick brown fox jumps';
		expect(scrubSecrets(text, 'abc')).toBe(text);
	});
});

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

describe('streamLLM', () => {
	it('retries a 429 before the first byte, then yields chunks in order', async () => {
		const { fetch: f, log } = scriptedFetch([rateLimited('0'), { stream: ['he', 'llo'] }]);
		setBaseFetch(f);
		const chunks: string[] = [];
		for await (const c of streamLLM(args())) chunks.push(c);
		expect(chunks.join('')).toBe('hello');
		expect(log).toHaveLength(2);
	});

	it('releases the slot after the first chunk (streaming chat never starves the lanes)', async () => {
		const { fetch: f } = scriptedFetch([{ stream: ['a', 'b', 'c'], chunkGapMs: 400 }, { delayMs: 10 }]);
		setBaseFetch(f);
		const chunks: string[] = [];
		const consuming = (async () => {
			for await (const c of streamLLM(args())) chunks.push(c);
		})();
		await vi.waitFor(() => expect(chunks).toEqual(['a']), { timeout: 2000 });
		// While the stream is still open (2 more chunks, 400ms apart), a
		// non-streaming call must acquire a slot and complete.
		const t0 = Date.now();
		expect(await callLLM(args())).toBe('T');
		expect(Date.now() - t0).toBeLessThan(350);
		await consuming;
		expect(chunks.join('')).toBe('abc');
	});

	it('caller abort before the first byte aborts the upstream fetch and releases the slot', async () => {
		// Regression: a canceled stream must not leave its streamText fetch
		// running against the endpoint (4-concurrent cap, no waiter).
		const { fetch: f, log } = scriptedFetch([{ hang: true }, { delayMs: 10 }]);
		setBaseFetch(f);
		const controller = new AbortController();
		const consuming = (async () => {
			for await (const _ of streamLLM(args({ signal: controller.signal }))) {
				// never reached: the scripted endpoint hangs
			}
		})();
		await waitFor(() => log.length === 1);
		controller.abort();
		await expect(consuming).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
		expect(log).toHaveLength(1); // canceled once — never retried
		expect(log[0].signal?.aborted).toBe(true); // upstream fetch was aborted
		// Slot released and fetch torn down: a fresh call completes at once.
		const t0 = Date.now();
		expect(await callLLM(args())).toBe('T');
		expect(Date.now() - t0).toBeLessThan(1000);
	});

	it('attempt timeout before the first byte: TimeoutError via the attempt abort ctrl, never retried', async () => {
		// The per-attempt timeout, honestly driven: timeoutMs is cranked down to
		// a few ms through the setLimits seam (beforeEach's resetGateway restores
		// the 30s default) and the scripted endpoint hangs, so the ONLY thing that
		// can end the attempt is withTimeout's attempt abort — no caller signal.
		setLimits({ timeoutMs: 80 });
		const { fetch: f, log } = scriptedFetch([{ hang: true }, {}]);
		setBaseFetch(f);
		const consuming = (async () => {
			for await (const _ of streamLLM(args())) {
				// never yielded: no first byte ever arrives
			}
		})();
		await expect(consuming).rejects.toSatisfy((e: unknown) => (e as Error).name === 'TimeoutError');
		expect(log).toHaveLength(1); // timed out once — never retried
		expect(log[0].signal?.aborted).toBe(true); // the attempt abort tore the fetch down
		// Slot was released: a fresh call must not wait on the timed-out lane.
		const t0 = Date.now();
		expect(await callLLM(args())).toBe('T');
		expect(Date.now() - t0).toBeLessThan(1000);
	});

	it('early consumer break aborts the upstream fetch', async () => {
		// Breaking out of the for-await after the first chunk must also
		// abort the still-running streamText fetch (generator finally).
		const { fetch: f, log } = scriptedFetch([{ stream: ['a'], chunkGapMs: 0 }, { delayMs: 10 }]);
		setBaseFetch(f);
		for await (const _ of streamLLM(args())) break;
		await vi.waitFor(() => expect(log[0].signal?.aborted).toBe(true), { timeout: 2000 });
		expect(await callLLM(args())).toBe('T'); // slot freed, fetch gone
	});

	it('mid-stream silence past inactivityTimeoutMs kills the stream as an honest timeout', async () => {
		// First byte arrives fast, then the endpoint goes silent forever —
		// the attempt timeout (seconds-to-cold-load scale) can't express
		// "healthy model, dead socket". The inactivity arm fires instead,
		// the upstream fetch is torn down, and the consumer reads an honest
		// TimeoutError — never a mid-stream retry (bytes already painted).
		setLimits({ inactivityTimeoutMs: 80, timeoutMs: 30_000 });
		// TWO chunks: with one, the finish_reason frame arrives immediately
		// after it (a healthy end-of-stream, no silence window at all).
		const { fetch: f, log } = scriptedFetch([{ stream: ['he', 'llo'], chunkGapMs: 60_000 }, {}]);
		setBaseFetch(f);
		const chunks: string[] = [];
		const consuming = (async () => {
			for await (const c of streamLLM(args())) chunks.push(c);
		})();
		await expect(consuming).rejects.toSatisfy(
			(e: unknown) => (e as Error).name === 'TimeoutError'
		);
		expect(chunks).toEqual(['he']); // painted bytes are never taken back
		expect(log).toHaveLength(1); // one attempt — no mid-stream retry
		expect(log[0].signal?.aborted).toBe(true); // zombie fetch aborted
		expect(await callLLM(args())).toBe('T'); // slot machinery still healthy
	});

	it('a slow-but-alive stream (gaps just under the arm) completes untouched', async () => {
		setLimits({ inactivityTimeoutMs: 400 });
		const { fetch: f } = scriptedFetch([{ stream: ['he', 'llo'], chunkGapMs: 120 }]);
		setBaseFetch(f);
		const chunks: string[] = [];
		for await (const c of streamLLM(args())) chunks.push(c);
		expect(chunks.join('')).toBe('hello');
	});
});

/* ------------------------------------------------------------------ *
 * fetchModels (sixth surface)
 * ------------------------------------------------------------------ */

describe('fetchModels through the gateway', () => {
	it('returns the sorted model list; Authorization carried; URL hit', async () => {
		const { fetch: f, log } = scriptedFetch([{ body: { data: [{ id: 'b' }, { id: 'a' }] } }]);
		setBaseFetch(f);
		expect(await fetchModels('https://api.test/v1', KEY)).toEqual({ ok: true, models: ['a', 'b'] });
		expect(log).toHaveLength(1);
		expect(log[0].url.endsWith('/models')).toBe(true);
		expect(log[0].headers['Authorization']).toBe(`Bearer ${KEY}`);
	});

	it('a 429 on /models is retried and then succeeds', async () => {
		const { fetch: f } = scriptedFetch([rateLimited('0'), { body: { data: [] } }]);
		setBaseFetch(f);
		expect(await fetchModels('https://api.test/v1', KEY)).toEqual({ ok: true, models: [] });
	});

	it('401 on /models maps to kind http with the status', async () => {
		const { fetch: f } = scriptedFetch([{ status: 401 }]);
		setBaseFetch(f);
		expect(await fetchModels('https://api.test/v1', KEY)).toEqual({ ok: false, kind: 'http', status: 401 });
	});
});
