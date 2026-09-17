/**
 * W53 · AI gateway — the single transport every LLM request flows through
 * (issue #53).
 *
 * Why this module exists: a BYOK caller can't know its endpoint's true
 * concurrency ceiling (LiteLLM-style proxies cap accounts per-key and
 * answer anything beyond with a 429 whose body can even leak a caller-key
 * hash — upstream LiteLLM issue #27884), and the AI SDK's default retry
 * (maxRetries=2) multiplied our fill lanes into request storms. So the
 * gateway owns:
 *   - a FIFO semaphore (default cap 2 — conservative against unknown
 *     endpoint ceilings and key-sharing consumers; configurable),
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
	/** In-flight requests across ALL LLM calls (default 2). Seeded under
	 * BROAD BYOK practice — a BYOK caller can't know its endpoint's true
	 * ceiling, so the floor stays low and a 429 shrinks the window further;
	 * a 429 proves the endpoint reached the gateway's request, so it is never
	 * a reason to go ABOVE this static start (spec §2 never-lie). */
	maxConcurrent?: number;
	/** Total attempts per logical call (default 3). */
	maxAttempts?: number;
	/** Per-attempt timeout, armed when the slot is LEASED (queue wait never
	 * counts) — default 30s. */
	timeoutMs?: number;
	/** Mid-stream silence bound (default 15s): a stream that has produced its
	 * first byte but then no bytes for this long is a healthy-connection/
	 * dead-socket case the per-attempt timeout can't express (the attempt
	 * may legitimately run longer while streaming). The kill aborts the
	 * upstream fetch and surfaces an honest TimeoutError — painted bytes
	 * are never taken back, and a stream mid-decode is never retried. */
	inactivityTimeoutMs?: number;
	/** Ceiling on a honored Retry-After (default 15s, under the fill lane's
	 * 60s per-chunk arm so one cooldown cycle can't expire queued lanes). */
	maxRetryAfterMs?: number;
}

export const DEFAULT_LIMITS: Required<GatewayLimits> = {
	maxConcurrent: 2,
	maxAttempts: 3,
	timeoutMs: 30_000,
	inactivityTimeoutMs: 15_000,
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
	paceWindows.clear();
	activeByBase.clear();
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

/* ------------------------------------------------------------------ *
 * Adaptive pacing (issue #64)
 *
 * Per-key proxy limits are CONCURRENCY ceilings, not rate quotas —
 * measured runs showed 429s falling exactly when lanes burst and stopping
 * when solo. A static cap + cooldown answers a storm with polite
 * re-attacks at the same size. This layer instead lets the gateway ADMIT
 * adaptively: a per-baseUrl window seeded at the static cap, halved
 * (floor 1) on every 429, grown +1 (ceiling — the static cap) per K
 * consecutive clean answers.
 * In-memory only, resetting with each page load: a bad evening for one run
 * never pins the next one slow. The global maxConcurrent remains the hard
 * ceiling; the window can only subtract from it, never exceed it.
 * ------------------------------------------------------------------ */

const paceWindows = new Map<string, { window: number; streak: number }>();
const activeByBase = new Map<string, number>();
const PACE_GROWTH_K = 4; // consecutive successes needed to grow the window by one

function paceWindow(baseUrl: string): number {
	const entry = paceWindows.get(baseUrl);
	return entry ? entry.window : limits.maxConcurrent;
}

function paceState(baseUrl: string): { window: number; streak: number } {
	let entry = paceWindows.get(baseUrl);
	if (!entry) {
		entry = { window: limits.maxConcurrent, streak: 0 };
		paceWindows.set(baseUrl, entry);
	}
	return entry;
}

function recordSuccess(baseUrl: string): void {
	const s = paceState(baseUrl);
	s.streak += 1;
	if (s.streak >= PACE_GROWTH_K) {
		s.streak = 0;
		s.window = Math.min(limits.maxConcurrent, s.window + 1);
	}
}

function recordRateLimited(baseUrl: string): void {
	const s = paceState(baseUrl);
	s.streak = 0;
	s.window = Math.max(1, Math.floor(s.window / 2));
}

function pacingAdmits(baseUrl: string): boolean {
	return (activeByBase.get(baseUrl) ?? 0) < paceWindow(baseUrl);
}

function admitFor(baseUrl: string): void {
	active++;
	activeByBase.set(baseUrl, (activeByBase.get(baseUrl) ?? 0) + 1);
}

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
		if (!pacingAdmits(w.baseUrl)) {
			i++; // window is full for this endpoint; another baseUrl may still run
			continue;
		}
		queue.splice(i, 1);
		admitFor(w.baseUrl);
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
	if (
		active < limits.maxConcurrent &&
		pacingAdmits(baseUrl) &&
		(cooldowns.get(baseUrl) ?? 0) <= Date.now()
	) {
		admitFor(baseUrl);
		waiter.run();
		return promise;
	}
	queue.push(waiter);
	return promise;
}

function release(baseUrl: string): void {
	active--;
	activeByBase.set(baseUrl, Math.max(0, (activeByBase.get(baseUrl) ?? 0) - 1));
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

/** Caller-supplied abort reason, lifted verbatim so cleanup aborts inherit
 * the caller's story instead of presenting an anonymous 'aborted without
 * reason'. */
function callerReason(signal: AbortSignal | undefined): unknown {
	return signal?.aborted === true ? signal.reason : undefined;
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
		release(args.provider.baseUrl);
		if (outcome.ok) {
			recordSuccess(args.provider.baseUrl);
			return outcome.text;
		}
		const err = outcome.err;
		if (isAbort(args.signal, err)) {
			throw err; // caller cancellation / attempt timeout — never retried
		}
		const status = statusOf(err);
		const message = scrubSecrets(String((err as Error | null)?.message ?? err), args.provider.apiKey);
		if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
			// The status rides IN the message: a 429's body typically carries
			// only rate-limit prose, and the banner's honest reason (spec §2)
			// must name the class — "429 Rate limit exceeded…" (ADR-018: no key).
			// network: true when no HTTP response ever arrived (the browser
			// block signature) so kindOf keeps that lane distinct.
			throw new GatewayError(status === 429 ? `429 ${message}` : message, status, status === undefined);
		}
		if (status === 429) {
			recordRateLimited(args.provider.baseUrl);
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
	err: unknown
): Promise<'retry' | never> {
	release(args.provider.baseUrl);
	if (isAbort(args.signal, err)) {
		throw err; // caller cancellation / attempt timeout — never retried
	}
	const status = statusOf(err);
	const message = scrubSecrets(String((err as Error | null)?.message ?? err), args.provider.apiKey);
	if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
		// Same 429-in-message + network-flag rule as callLLM (see there).
		throw new GatewayError(status === 429 ? `429 ${message}` : message, status, status === undefined);
	}
	if (status === 429) {
		recordRateLimited(args.provider.baseUrl);
		setCooldown(args.provider.baseUrl, Date.now() + waitMs(status, err, attempt));
	} else await sleep(waitMs(status, err, attempt), args.signal);
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
		// waiter (a capped endpoint fills its ceiling with zombies).
		const abortCtrl = new AbortController();
		// Abandoned-iterator hygiene (created per attempt, replaced inside
		// the try once the iterator exists): the finally MUST see it, so it
		// hoists above the try scope. No-op until the iterator is born.
		let drainIterator: () => Promise<void> = async () => {};
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
			// When a timeout makes us leave an in-flight events.next() behind,
			// closing the iterator lets the SDK settle its internal stream
			// BEFORE we kill the fetch — its pending promises then resolve
			// (done) instead of rejecting unhandled as "Uncaught (in promise)
			// AbortError". Capped to 2s: a wedged close must never hold the slot.
			drainIterator = async (): Promise<void> => {
				if (events.return === undefined) return;
				const close = events.return();
				close.catch(() => {});
				await Promise.race([
					close,
					new Promise<void>((resolve) => setTimeout(resolve, 2000))
				]).catch(() => {});
			};
			for (;;) {
				let part: Awaited<ReturnType<typeof events.next>>['value'] | undefined;
				try {
					// First byte races the attempt timeout; after the first byte,
					// the attempt abort fires only when this attempt exits.
					// Per-call first-byte budget (chat=60s, spec §5 slow lane);
					// default stays the lane-wide 30s.
					const firstByteMs = args.timeoutMs ?? limits.timeoutMs;
					const firstP = events.next();
					firstP.catch(() => {});
					const first = await withTimeout(firstP, firstByteMs, args.signal);
					if (first.done) {
						release(args.provider.baseUrl);
						return; // empty response — nothing to interpret, no lie to tell
					}
					part = first.value;
				} catch (err) {
					if ((await drainAttempt(args, attempt, startMs, err)) === 'retry') continue attempts;
				}
				if (part === undefined) {
					// Unreachable safety (first.done was false, so part was assigned)
					// — but the slot must not be held across the next attempt either way.
					release(args.provider.baseUrl);
					continue attempts;
				}
				if (part.type === 'error') {
					if ((await drainAttempt(args, attempt, startMs, part.error)) === 'retry') continue attempts;
				}
				if (part.type !== 'text-delta') continue; // protocol part — keep reading

				// First byte = a successful attempt for the pacing window (issue #64):
				// count it BEFORE giving the slot back.
				recordSuccess(args.provider.baseUrl);
				release(args.provider.baseUrl); // bytes are flowing — give the lane back
				yield part.text;
				// Mid-stream: no retry (output already delivered); errors surface
				// honestly as their scrubbed text (spec §2).
				for (;;) {
					// Inactivity arm: the per-attempt timeout covers "nothing ever
					// arrived", but a stream that answered once and then went
					// silent (healthy connection, dead socket/runtime) would hang
					// a consumer until its own caller-side arm fired. Kill it
					// honestly here — the Generator's `finally` aborts the
					// upstream fetch, and the painted bytes stay painted.
					// Race-loser hygiene: on timeout the original next() promise
					// keeps running; when the cleanup abort then kills the SDK
					// fetch, that orphaned promise REJECTS unhandled (Chrome:
					// "Uncaught (in promise) AbortError: signal is aborted
					// without reason", 2026-09-17). Observe-and-swallow.
					// The per-call budget doubles as the mid-stream-no-progress
					// arm: a provider silent for 60s on first byte stalls the same
					// way between deltas (same shared-GPU physics, chat 60s).
					const nextP = events.next();
					nextP.catch(() => {});
					const next = await withTimeout(nextP, args.timeoutMs ?? limits.inactivityTimeoutMs, args.signal);
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
			// Settle the abandoned iterator first (its pending next() resolves
			// done — silence; decision 2026-09-17), THEN kill the fetch.
			// Reason-carrying cleanup: the kill that ends a first-byte-timeout
			// or mid-stream-silence fetch must not read as an anonymous reason —
			// downstream listeners and DevTools show signal.reason verbatim.
			await drainIterator();
			abortCtrl.abort(callerReason(args.signal) ?? new DOMException('stream cleaned up (first-byte timeout, retry, or consumer exit)', 'AbortError')); // never leave a first-byte-timeout stream in flight
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
			release(baseUrl);
			if (isAbort(callerSignal, err)) {
				throw err;
			}
			const status = statusOf(err);
			const message = scrubSecrets(String((err as Error | null)?.message ?? err), apiKey);
			if (!isRetryable(status, err) || attempt === limits.maxAttempts) {
				throw new GatewayError(message, status, status === undefined);
			}
			if (status === 429) {
				recordRateLimited(baseUrl);
				setCooldown(baseUrl, Date.now() + waitMs(status, err, attempt));
			} else await sleep(waitMs(status, err, attempt), callerSignal);
			continue;
		}
		release(baseUrl);
		if (response.ok || !isRetryable(response.status, { status: response.status })) {
			if (response.ok) recordSuccess(baseUrl);
			return response;
		}
		if (attempt === limits.maxAttempts) {
			const message = scrubSecrets(`HTTP ${response.status} from ${baseUrl}`, apiKey);
			throw new GatewayError(message, response.status);
		}
		if (response.status === 429) {
			recordRateLimited(baseUrl);
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
