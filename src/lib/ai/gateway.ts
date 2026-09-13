/**
 * W53 · AI gateway — the single transport every LLM request flows through
 * (issue #53).
 *
 * Why this module exists: the primary dev endpoint (e-infra's LiteLLM
 * gateway) caps an account at 4 CONCURRENT requests and answers anything
 * beyond with a 429 whose body leaks the caller's key hash (upstream
 * LiteLLM issue #27884) — and the AI SDK's default retry (maxRetries=2)
 * multiplied our fill lanes into request storms. So the gateway owns:
 *   - a FIFO semaphore (default cap 2 — headroom under e-infra's 4 for other
 *     traffic sharing the key; configurable),
 *   - the ONLY retry loop (generateText/streamText are called with
 *     maxRetries: 0; provider-config maxRetries is ignored by the SDK —
 *     probe-verified), retrying just 429/5xx/network a bounded number of
 *     times, honoring Retry-After (capped + jittered),
 *   - a per-baseUrl cooldown: one 429 parks every queued ticket for that
 *     endpoint until Retry-After elapses — this is ALSO the only cross-tab
 *     safety, because a per-tab semaphore cannot see other tabs' requests
 *     (3 tabs × cap 2 > 4),
 *   - ADR-018 scrubbing: every message leaving this module masks the api key,
 *     its JSON-escaped form, its sha256 (what LiteLLM echoes), and any
 *     `api_key:`-labeled token.
 *
 * Deliberately NOT here: parsing, prompts, zod. generateStructured keeps the
 * clean transport/parse split (C1 contract) — this module is transport
 * reliability only. A 5xx or network error does NOT set a cooldown (per-call
 * backoff only); only a 429 speaks for the endpoint's capacity.
 */
import { generateText, streamText, type LanguageModel, type TextStreamPart } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { CallLLM, CallLLMArgs } from './output';

/* ------------------------------------------------------------------ *
 * Limits & configuration
 * ------------------------------------------------------------------ */

export interface GatewayLimits {
	/** In-flight requests across ALL LLM calls (default 2, under e-infra's 4). */
	maxConcurrent?: number;
	/** Total attempts per logical call (default 3). */
	maxAttempts?: number;
	/** Per-attempt timeout, armed when the slot is LEASED (queue wait never
	 * counts) — default 30s. */
	timeoutMs?: number;
	/** Ceiling on a honored Retry-After (default 15s, under the fill lane's
	 * 25s per-chunk arm so one cooldown cycle can't expire queued lanes). */
	maxRetryAfterMs?: number;
}

export const DEFAULT_LIMITS: Required<GatewayLimits> = {
	maxConcurrent: 2,
	maxAttempts: 3,
	timeoutMs: 30_000,
	maxRetryAfterMs: 15_000
};

let limits: Required<GatewayLimits> = { ...DEFAULT_LIMITS };

/** Test seam: override one or more limits; resetGateway() restores defaults.
 * The per-attempt timeout must be drivable down to a few ms so an honest
 * first-byte-timeout test can watch it fire without a 30s wall clock. */
export function setLimits(over: Partial<GatewayLimits>): void {
	limits = { ...limits, ...over };
}

/** Full reset — test seam. Rejects queued waiters so no ticket leaks. */
export function resetGateway(): void {
	for (const w of queue.splice(0)) w.reject(abortError());
	for (const t of cooldownTimers.values()) clearTimeout(t);
	cooldowns.clear();
	cooldownTimers.clear();
	limits = { ...DEFAULT_LIMITS };
	injectedFetch = null;
	secretHashes.clear();
}

/* ------------------------------------------------------------------ *
 * Test seam: base fetch
 * ------------------------------------------------------------------ */

/** Injectable fake (test seam); null = follow globalThis.fetch LIVE at call
 * time — existing suites stub the global fetch after module import. */
let injectedFetch: typeof fetch | null = null;

const liveFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
	(injectedFetch ?? globalThis.fetch)(input, init)) as unknown as typeof fetch;

export function setBaseFetch(f: typeof fetch | undefined): void {
	injectedFetch = f ?? null;
}

/* ------------------------------------------------------------------ *
 * FIFO semaphore + per-baseUrl cooldowns
 * ------------------------------------------------------------------ */

interface Waiter {
	baseUrl: string;
	signal?: AbortSignal;
	run: () => void;
	reject: (e: unknown) => void;
}

const queue: Waiter[] = [];
let active = 0;
const cooldowns = new Map<string, number>();
const cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();

function pump(): void {
	if (active >= limits.maxConcurrent) return;
	const now = Date.now();
	for (let i = 0; i < queue.length; ) {
		const w = queue[i];
		if (w.signal?.aborted) {
			queue.splice(i, 1);
			w.reject(abortError());
			continue;
		}
		if ((cooldowns.get(w.baseUrl) ?? 0) > now) {
			i++; // parked for this endpoint; a later baseUrl may still run
			continue;
		}
		queue.splice(i, 1);
		active++;
		w.run();
		if (active >= limits.maxConcurrent) return;
	}
}

function acquire(baseUrl: string, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const waiter: Waiter = {
		baseUrl,
		signal,
		run: () => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		},
		reject
	};
	const onAbort = (): void => {
		const idx = queue.indexOf(waiter);
		if (idx >= 0) {
			queue.splice(idx, 1);
			reject(abortError());
		}
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) {
		signal.removeEventListener('abort', onAbort);
		reject(abortError());
		return promise;
	}
	if (active < limits.maxConcurrent && (cooldowns.get(baseUrl) ?? 0) <= Date.now()) {
		active++;
		waiter.run();
		return promise;
	}
	queue.push(waiter);
	return promise;
}

function release(): void {
	active--;
	pump();
}

/** Park every ticket for `baseUrl` until `until`; the expiry timer re-pumps.
 * Never shortens an existing, longer cooldown. */
function setCooldown(baseUrl: string, until: number): void {
	const prev = cooldowns.get(baseUrl) ?? 0;
	if (until <= prev) return;
	cooldowns.set(baseUrl, until);
	const timer = cooldownTimers.get(baseUrl);
	if (timer) clearTimeout(timer);
	const wake = setTimeout(() => {
		cooldowns.delete(baseUrl);
		cooldownTimers.delete(baseUrl);
		pump();
	}, Math.max(0, until - Date.now()));
	(wake as { unref?: () => void }).unref?.();
	cooldownTimers.set(baseUrl, wake);
}

/* ------------------------------------------------------------------ *
 * Error classification, backoff, scrub (ADR-018)
 * ------------------------------------------------------------------ */

/** Thrown with a SCRUBBED message once retries are exhausted (or immediately
 * for non-retryable statuses). `statusCode` rides along so output.ts kindOf
 * can classify honestly — including the 429 branch. `network` is set when the
 * fetch rejected with NO HTTP response (the CORS/mixed-content signature):
 * status-less, so the lane must not be mislabeled "unreachable" or "http"
 * (spec §2 never-lie). */
export class GatewayError extends Error {
	readonly statusCode?: number;
	readonly network?: boolean;
	constructor(message: string, statusCode?: number, network?: boolean) {
		super(message);
		this.name = 'GatewayError';
		this.statusCode = statusCode;
		this.network = network;
	}
}

function statusOf(err: unknown): number | undefined {
	return (err as { statusCode?: number } | null)?.statusCode;
}

function headersOf(err: unknown): Record<string, string> | undefined {
	return (err as { responseHeaders?: Record<string, string> } | null)?.responseHeaders;
}

/** Retry-After as seconds or HTTP-date, or retry-after-ms (AI SDK
 * convention). Returns ms, or null when absent/unparseable. */
function parseRetryAfter(err: unknown): number | null {
	const headers = headersOf(err);
	if (!headers) return null;
	const get = (name: string): string | undefined => {
		const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
		return key === undefined ? undefined : headers[key];
	};
	const ms = get('retry-after-ms');
	if (ms !== undefined && ms !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
	const raw = get('retry-after');
	if (raw === undefined || raw === '') return null;
	const secs = Number(raw);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const when = Date.parse(raw);
	return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

function isRetryable(status: number | undefined, err: unknown): boolean {
	if (status === 429) return true;
	if (status !== undefined) return status >= 500;
	// No HTTP status: a fetch that rejected before a response (network/CORS).
	return err instanceof TypeError;
}

/** ±20% jitter — de-synchronizes simultaneous retries. */
function jittered(ms: number): number {
	return Math.round(ms * (0.8 + Math.random() * 0.4));
}
const secretHashes = new Map<string, string>();

/** Precompute sha256(apiKey) — exactly what LiteLLM echoes in its 429 body
 * (upstream #27884). Idempotent; memory-only (ADR-018: the key and its hash
 * never leave the tab). */
export async function primeSecrets(apiKey: string): Promise<void> {
	if (apiKey.length < 8 || secretHashes.has(apiKey)) return;
	try {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
		secretHashes.set(
			apiKey,
			[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
		);
	} catch {
		// No SubtleCrypto (unusual context) — the label regex below still guards.
	}
}

/** Mask the key, its JSON-escaped form, its sha256, and any
 * `api_key:`/`Bearer`-labeled token in surfaced text (ADR-018). The labeled
 * form matters because endpoints TRUNCATE the echoed token, so exact-match
 * alone cannot remove the prefix. */
export function scrubSecrets(text: string, apiKey: string): string {
	let out = text;
	if (apiKey.length >= 8) {
		const escaped = JSON.stringify(apiKey).slice(1, -1);
		for (const secret of [apiKey, escaped, secretHashes.get(apiKey)]) {
			if (secret !== undefined && secret.length >= 8) out = out.replaceAll(secret, '••••');
		}
	}
	return out.replace(
		/(api[_-]?key|apikey|bearer|authorization)(\s*["':=]+\s*)([A-Za-z0-9_.\-~+/]{8,})/gi,
		'$1$2••••'
	);
}

/** Wait for a 429 (Retry-After, capped) or back off exponentially otherwise.
 * Jitter widens a wait ±20% but never shrinks a Retry-After below the
 * endpoint's stated value (only our own backoffs may run short). */
function waitMs(status: number | undefined, err: unknown, attempt: number): number {
	if (status === 429) {
		const ra = parseRetryAfter(err);
		if (ra === null) return jittered(Math.min(1200, limits.maxRetryAfterMs));
		if (ra <= limits.maxRetryAfterMs) return jitterUp(ra);
		return jitterUp(limits.maxRetryAfterMs); // cap an absurd Retry-After
	}
	return jittered(500 * 2 ** (attempt - 1));
}

function jitterUp(ms: number): number {
	return Math.round(ms * (1 + Math.random() * 0.2));
}

function abortError(): Error {
	return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbort(callerSignal: AbortSignal | undefined, err: unknown): boolean {
	return (
		callerSignal?.aborted === true ||
		['AbortError', 'TimeoutError'].includes(String((err as Error | null)?.name))
	);
}

/* ------------------------------------------------------------------ *
 * Transport core
 * ------------------------------------------------------------------ */

function buildModel(args: CallLLMArgs): LanguageModel {
	const p = createOpenAICompatible({
		baseURL: args.provider.baseUrl,
		name: args.provider.name,
		apiKey: args.provider.apiKey,
		fetch: liveFetch
	});
	return p(args.provider.model);
}
/** One transport attempt either yields the model text or throws. */
type AttemptResult = { ok: true; text: string } | { ok: false; err: unknown };

async function textAttempt(args: CallLLMArgs, signal: AbortSignal): Promise<string> {
	const result = await generateText({
		model: buildModel(args),
		system: args.system,
		messages: args.messages,
		temperature: args.temperature,
		abortSignal: signal,
		maxRetries: 0
	});
	return result.text;
}
/** Caller abort beats the attempt timeout; both end the attempt unretried. */
function attemptSignal(args: CallLLMArgs): AbortSignal {
	const signals: AbortSignal[] = [AbortSignal.timeout(limits.timeoutMs)];
	if (args.signal) signals.push(args.signal);
	return AbortSignal.any(signals);
}

/** Shared retry loop for non-streaming calls: acquire → attempt → classify →
 * cooldown/backoff → retry. 429 waits happen in acquire (the cooldown), so a
 * retrying call re-queues behind the same parking as everyone else. */
export const callLLM: CallLLM = async (args) => {
	await primeSecrets(args.provider.apiKey);
	for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
		await acquire(args.provider.baseUrl, args.signal);
		const startMs = Date.now();
		const signal = attemptSignal(args);
		let outcome: AttemptResult;
		try {
			outcome = { ok: true, text: await textAttempt(args, signal) };
		} catch (err) {
			outcome = { ok: false, err };
		}
		release();
		if (outcome.ok) return outcome.text;
		const err = outcome.err;
		if (isAbort(args.signal, err)) {
			throw err; // caller cancellation / attempt timeout — never retried
		}
		const status = statusOf(err);
		const message = scrubSecrets(String((err as Error | null)?.message ?? err), args.provider.apiKey);
		if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
			// The status rides IN the message: e-infra's 429 body carries only
			// rate-limit prose, and the banner's honest reason (spec §2) must
			// name the class — "429 Rate limit exceeded…" (ADR-018: no key).
			// network: true when no HTTP response ever arrived (the browser
			// block signature) so kindOf keeps that lane distinct.
			throw new GatewayError(status === 429 ? `429 ${message}` : message, status, status === undefined);
		}
		if (status === 429) {
			setCooldown(args.provider.baseUrl, Date.now() + waitMs(status, err, attempt));
		} else {
			await sleep(waitMs(status, err, attempt), args.signal);
		}
	}
	throw new GatewayError('unreachable: exhausted attempts'); // loop always exits above
};

/** Streaming arm: the slot is held ONLY until the first byte, then released —
 * a long chat answer never starves the fill lanes (issue #53). A failure
 * before the first byte retries through the same rules as callLLM; a
 * mid-stream failure surfaces honestly (spec §2) as a scrubbed GatewayError. */
/** Classify a failed attempt and put the call to bed: record, scrub, and
 * either throw-honestly or set the retry gate. Shared by callLLM and
 * streamLLM — the retry rules live exactly once. Returns the thrown/steer
 * decision; callers release() and then follow it. */
async function drainAttempt(
	args: CallLLMArgs,
	attempt: number,
	startMs: number,
	err: unknown,
	release: () => void
): Promise<'retry' | never> {
	release();
	if (isAbort(args.signal, err)) {
		throw err; // caller cancellation / attempt timeout — never retried
	}
	const status = statusOf(err);
	const message = scrubSecrets(String((err as Error | null)?.message ?? err), args.provider.apiKey);
	if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
		// Same 429-in-message + network-flag rule as callLLM (see there).
		throw new GatewayError(status === 429 ? `429 ${message}` : message, status, status === undefined);
	}
	if (status === 429) setCooldown(args.provider.baseUrl, Date.now() + waitMs(status, err, attempt));
	else await sleep(waitMs(status, err, attempt), args.signal);
	return 'retry';
}

export const streamLLM = async function* (args: CallLLMArgs): AsyncIterable<string> {
	await primeSecrets(args.provider.apiKey);
	attempts: for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
		await acquire(args.provider.baseUrl, args.signal);
		const startMs = Date.now();
		// Per-attempt abort controller: on first-byte timeout, retry, or early
		// consumer cancel the upstream streamText fetch MUST be aborted —
		// otherwise the request keeps running against the endpoint with no
		// waiter (e-infra's 4-concurrent cap fills with zombies).
		const abortCtrl = new AbortController();
		try {
			const stream = streamText({
				model: buildModel(args),
				system: args.system,
				messages: args.messages,
				temperature: args.temperature,
				abortSignal: args.signal
					? AbortSignal.any([args.signal, abortCtrl.signal])
					: abortCtrl.signal,
				maxRetries: 0
			});
			// AI SDK's textStream swallows open-time errors (a 429 just ends it);
			// the error rides a fullStream 'error' part instead. Walk fullStream —
			// created ONCE per attempt; its parts are: protocol noise, one error
			// (retry path), or text-delta (bytes flowing).
			const events = stream.fullStream[Symbol.asyncIterator]();
			for (;;) {
				let part: Awaited<ReturnType<typeof events.next>>['value'] | undefined;
				try {
					// First byte races the attempt timeout; after the first byte,
					// the attempt abort fires only when this attempt exits.
					const first = await withTimeout(events.next(), limits.timeoutMs, args.signal);
					if (first.done) {
						release();
						return; // empty response — nothing to interpret, no lie to tell
					}
					part = first.value;
				} catch (err) {
					if ((await drainAttempt(args, attempt, startMs, err, release)) === 'retry') continue attempts;
				}
				if (part === undefined) {
					// Unreachable safety (first.done was false, so part was assigned)
					// — but the slot must not be held across the next attempt either way.
					release();
					continue attempts;
				}
				if (part.type === 'error') {
					if ((await drainAttempt(args, attempt, startMs, part.error, release)) === 'retry') continue attempts;
				}
				if (part.type !== 'text-delta') continue; // protocol part — keep reading

				release(); // bytes are flowing — give the lane back
				yield part.text;
				// Mid-stream: no retry (output already delivered); errors surface
				// honestly as their scrubbed text (spec §2).
				for (;;) {
					const next = await events.next();
					if (next.done) return;
					if (next.value.type === 'text-delta') yield next.value.text;
					else if (next.value.type === 'error') {
						throw new GatewayError(
							scrubSecrets(
								String((next.value.error as Error | null)?.message ?? next.value.error),
								args.provider.apiKey
							),
							statusOf(next.value.error)
						);
					}
				}
			}
		} finally {
			abortCtrl.abort(); // never leave a first-byte-timeout stream in flight
		}
	}
};

/** Raw-JSON arm for the /models surface (issue #53: it eats the same cap).
 * Retryable statuses are retried and exhausted into a GatewayError; any final
 * Response — including non-retryable non-ok — is returned for the caller's
 * own honest mapping. */
export async function gatewayFetch(
	url: string,
	init?: RequestInit & { apiKey?: string }
): Promise<Response> {
	const apiKey = init?.apiKey ?? '';
	const callerSignal = init?.signal ?? undefined;
	await primeSecrets(apiKey);
	const baseUrl = url.replace(/\/models\/?$/, '').replace(/\/+$/, '');
	for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
		await acquire(baseUrl, callerSignal);
		const startMs = Date.now();
		let response: Response;
		try {
			const { signal, apiKey: _ignored, ...rest } = init ?? {};
			const signals: AbortSignal[] = [AbortSignal.timeout(limits.timeoutMs)];
			if (signal) signals.push(signal);
			response = await liveFetch(url, { ...rest, signal: AbortSignal.any(signals) });
		} catch (err) {
			release();
			if (isAbort(callerSignal, err)) {
				throw err;
			}
			const status = statusOf(err);
			const message = scrubSecrets(String((err as Error | null)?.message ?? err), apiKey);
			if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
				throw new GatewayError(message, status, status === undefined);
			}
			if (status === 429) setCooldown(baseUrl, Date.now() + waitMs(status, err, attempt));
			else await sleep(waitMs(status, err, attempt), callerSignal);
			continue;
		}
		release();
		if (response.ok || !isRetryable(response.status, { status: response.status })) {
			return response;
		}
		if (attempt === limits.maxAttempts) {
			const message = scrubSecrets(`HTTP ${response.status} from ${baseUrl}`, apiKey);
			throw new GatewayError(message, response.status);
		}
		if (response.status === 429) {
			const headers: Record<string, string> = {};
			response.headers.forEach((v, k) => (headers[k] = v));
			setCooldown(baseUrl, Date.now() + waitMs(429, { responseHeaders: headers }, attempt));
		} else {
			await sleep(waitMs(response.status, null, attempt), callerSignal);
		}
	}
	throw new GatewayError('unreachable: exhausted attempts');
}

/* ------------------------------------------------------------------ *
 * Small async helpers
 * ------------------------------------------------------------------ */

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal?.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	(timer as { unref?: () => void }).unref?.();
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(abortError());
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) {
		clearTimeout(timer);
		signal.removeEventListener('abort', onAbort);
		reject(abortError());
	}
	return promise;
}

function withTimeout<T>(p: Promise<T>, ms: number, callerSignal?: AbortSignal): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		callerSignal?.removeEventListener('abort', onAbort);
		reject(new DOMException('The operation timed out.', 'TimeoutError'));
	}, ms);
	(timer as { unref?: () => void }).unref?.();
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(abortError());
	};
	callerSignal?.addEventListener('abort', onAbort, { once: true });
	p.then(
		(v) => {
			clearTimeout(timer);
			callerSignal?.removeEventListener('abort', onAbort);
			resolve(v);
		},
		(e) => {
			clearTimeout(timer);
			callerSignal?.removeEventListener('abort', onAbort);
			reject(e);
		}
	);
	return promise;
}
