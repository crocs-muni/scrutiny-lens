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
 *   - a per-baseUrl FIFO admission window (issue #104): seeded at 1, grown
 *     +1 per 4 consecutive clean answers up to the per-host ceiling
 *     (HOST_CONCURRENCY_CEILINGS, e.g. e-infra's measured 4-parallel
 *     account cap), generic fallback maxConcurrent for unknown hosts,
 *     halved (floor 1) on a 429 or a proactive remaining-requests ≤ 1
 *     header. Streams hold their slot for their WHOLE lifetime — the
 *     endpoint counts open requests server-side.
 *   - the ONLY retry loop (generateText/streamText are called with
 *     maxRetries: 0; provider-config maxRetries is ignored by the SDK —
 *     probe-verified), retrying just 429/5xx/network a bounded number of
 *     times, honoring Retry-After (capped + jittered),
 *   - a per-baseUrl cooldown: one 429 parks every queued ticket for that
 *     endpoint until Retry-After elapses — this is ALSO the only cross-tab
 *     safety, because a per-tab semaphore cannot see other tabs' requests
 *     (3 tabs × window 2 > 4),
 *   - ADR-018 scrubbing: every message leaving this module masks the api key,
 *     its JSON-escaped form, its sha256 (what LiteLLM echoes), and any
 *     `api_key:`-labeled token.
 *
 * Deliberately NOT here: parsing, prompts, zod. generateStructured keeps the
 * clean transport/parse split (C1 contract) — this module is transport
 * reliability only. A 5xx or network error does NOT set a cooldown (per-call
 * backoff only); only a 429 speaks for the endpoint's capacity.
 */
import { generateText, streamText, type LanguageModel, type TextStreamPart, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { HOST_CONCURRENCY_CEILINGS } from '$lib/config';
import type { CallLLM, CallLLMArgs } from './output';
import type { ProviderConfig } from './provider';

/* ------------------------------------------------------------------ *
 * Limits & configuration
 * ------------------------------------------------------------------ */

export interface GatewayLimits {
	/** Generic per-host FALLBACK ceiling for the adaptive pacing window
	 * (issue #104): how far a baseUrl's window may grow when the host is
	 * NOT in HOST_CONCURRENCY_CEILINGS (default 2). No longer a global cap
	 * — windows are per baseUrl and seed at 1 regardless. Seeded low under
	 * BROAD BYOK practice — a BYOK caller can't know its endpoint's true
	 * ceiling, so the fallback stays low and a 429 shrinks the window
	 * further; a 429 proves the endpoint reached the gateway's request, so
	 * it is never a reason to go ABOVE the fallback (spec §2 never-lie). */
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
	surfaced429 = 0;
	reasoningCapability.clear();
	reasoningProbes.clear();
}

/* ------------------------------------------------------------------ *
 * Reasoning-effort probe (issue #107) — behavioral, cached per session
 * ------------------------------------------------------------------ */

/** A non-honoring endpoint SILENTLY IGNORES reasoning_effort (never a
 * 400), so support can only be read behaviorally: ask for low effort on
 * one trivial prompt and look at what came back. No reasoning surface at
 * all = the endpoint suppressed its thinking (honored) or never had any
 * (a non-reasoning model — the param is equally harmless there), so the
 * param rides. Reasoning content/tokens in the answer = the endpoint
 * ignored the ask; the param stays off from then on (spec §2: a param
 * the endpoint discards is intent we must not keep claiming). Cached per
 * (baseUrl, model) for the session — exactly one probe per pair. */
const reasoningCapability = new Map<string, boolean>();
const reasoningProbes = new Map<string, Promise<boolean>>();

function reasoningProbeKey(provider: ProviderConfig): string {
	return `${provider.baseUrl}::${provider.model}`;
}

/** The param every interpret-lane request carries — after the verdict.
 * The probe forces it on; that param IS the question being asked. */
function reasoningProviderOptions(
	args: CallLLMArgs,
	force: boolean
): { openaiCompatible: { reasoningEffort: 'low' } } | undefined {
	if (args.reasoningEffort !== 'low') return undefined;
	if (!force && reasoningCapability.get(reasoningProbeKey(args.provider)) !== true) {
		return undefined;
	}
	return { openaiCompatible: { reasoningEffort: 'low' } };
}

/** One cheap probe per (baseUrl, model) per session; concurrent first
 * callers coalesce onto it, repeat calls hit the cache with zero extra
 * requests. The probe runs through the normal call path (FIFO slot,
 * retry, cooldowns — it queues like any call). A failed probe caches
 * false: detection never blocks a fill — the fill just goes uncapped.
 * Takes the full provider (the probe authenticates like any request);
 * the cache key is per ruling (baseUrl, model) — the key never leaves. */
export async function reasoningEffortSupported(
	provider: ProviderConfig,
	signal?: AbortSignal
): Promise<boolean> {
	const key = reasoningProbeKey(provider);
	const known = reasoningCapability.get(key);
	if (known !== undefined) return known;
	let inflight = reasoningProbes.get(key);
	if (inflight === undefined) {
		const probeStart = Date.now();
		// URL-derived host, never the key (same surface as records' lane logs).
		let probeHost = provider.baseUrl;
		try {
			probeHost = new URL(provider.baseUrl).host;
		} catch {
			/* unparseable baseUrl logs verbatim */
		}
		inflight = callLLMInner(
			{
				provider,
				messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
				temperature: 0,
				reasoningEffort: 'low',
				signal
			},
			/* probeSelf */ true
		).then(
			(outcome) => ({ reachable: true, reasoningObserved: outcome.reasoningObserved }),
			// A failed probe reads as "couldn't detect" → false, never a
			// taint on the fill it was preparing.
			() => ({ reachable: false, reasoningObserved: true })
		).then((verdict) => {
			const supported = !verdict.reasoningObserved;
			// resetGateway during flight must not resurrect a stale verdict.
			if (reasoningProbes.get(key) === inflight) reasoningCapability.set(key, supported);
			reasoningProbes.delete(key);
			if (!supported && verdict.reachable) {
				// Honest signal (issue #107's optional debug read): the
				// MEASURED first-answer latency of this model's probe — real
				// numbers only, host + model, never the key (spec §2/ADR-018).
				// Only an endpoint that ANSWERED earns this line — a probe
				// that failed says nothing about the model.
				console.debug(
					`[ai:probe] ${probeHost}/${provider.model} reasoned at low effort after ${String(Date.now() - probeStart)}ms — reasoning_effort off for the session`
				);
			}
			return supported;
		});
		reasoningProbes.set(key, inflight);
	}
	return inflight;
}

/* ------------------------------------------------------------------ *
 * Surfaced-429 counter (issue #105)
 * ------------------------------------------------------------------ */

/** Every 429 the endpoint ANSWERED this page's lifetime — the raw material
 * for the banner's "endpoint rate limited N×" (spec §2 honest
 * instrumentation: it counts only what the endpoint actually said, so a run
 * whose retries cleared everything reads 0 and says nothing). */
let surfaced429 = 0;

/** Read seam for the smoke and the results banner: 429s seen so far. */
export function surfaced429Count(): number {
	return surfaced429;
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
const cooldowns = new Map<string, number>();
const cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();

/* ------------------------------------------------------------------ *
 * Adaptive pacing (issues #64, #104)
 *
 * Per-key proxy limits are CONCURRENCY ceilings, not rate quotas —
 * measured runs showed 429s falling exactly when lanes burst and stopping
 * when solo. A static cap + cooldown answers a storm with polite
 * re-attacks at the same size. This layer instead lets the gateway ADMIT
 * adaptively: a per-baseUrl window SEEDED AT 1 (issue #104 — presume no
 * headroom, earn it), halved (floor 1) on every 429 or on a proactive
 * x-ratelimit-remaining ≤ 1 success header, grown +1 per K consecutive
 * clean answers up to the PER-HOST ceiling (HOST_CONCURRENCY_CEILINGS:
 * e-infra's LiteLLM account cap measured at 4 parallel open requests)
 * with limits.maxConcurrent as the generic fallback for unknown hosts.
 * In-memory only, resetting with each page load: a bad evening for one
 * run never pins the next one slow. There is NO global cap anymore —
 * different endpoints never share admission (a busy e-infra must not
 * starve a localhost Ollama, and one host's window tells the gateway
 * nothing about another's capacity — spec §2).
 * ------------------------------------------------------------------ */

const paceWindows = new Map<string, { window: number; streak: number }>();
const activeByBase = new Map<string, number>();
const PACE_GROWTH_K = 4; // consecutive successes needed to grow the window by one

/** The host's pacing ceiling (issue #104): the config pin for a known
 * host, else the generic fallback. A baseUrl that won't parse gets the
 * fallback — a malformed URL must not invent headroom (spec §2). */
function ceilingFor(baseUrl: string): number {
	try {
		return HOST_CONCURRENCY_CEILINGS[new URL(baseUrl).hostname] ?? limits.maxConcurrent;
	} catch {
		return limits.maxConcurrent;
	}
}

function paceWindow(baseUrl: string): number {
	const entry = paceWindows.get(baseUrl);
	return entry ? entry.window : 1;
}

function paceState(baseUrl: string): { window: number; streak: number } {
	let entry = paceWindows.get(baseUrl);
	if (!entry) {
		entry = { window: 1, streak: 0 }; // seed 1 per baseUrl (issue #104)
		paceWindows.set(baseUrl, entry);
	}
	return entry;
}

function recordSuccess(baseUrl: string): void {
	const s = paceState(baseUrl);
	s.streak += 1;
	if (s.streak >= PACE_GROWTH_K) {
		s.streak = 0;
		s.window = Math.min(ceilingFor(baseUrl), s.window + 1);
	}
}

/** Halve the admission window (floor 1) and drop the clean streak — the
 * shared reaction to capacity pressure (issue #104). */
function halveWindow(baseUrl: string): void {
	const s = paceState(baseUrl);
	s.streak = 0;
	s.window = Math.max(1, Math.floor(s.window / 2));
}

function recordRateLimited(baseUrl: string): void {
	halveWindow(baseUrl);
	// Issue #105: this is THE single funnel every 429 flows through
	// (callLLM, streamLLM, and both gatewayFetch arms), so the count lives
	// here — never beside one arm, where a lane could throttle uncounted.
	surfaced429 += 1;
}

/** Proactive shave (issue #104): a success header says the account is
 * nearly out of headroom — halve what the NEXT burst admits. Unlike
 * recordRateLimited this arms NO cooldown: the endpoint has not said
 * stop, and #105 counts real 429s separately from this gentler signal. */
function recordNearLimit(baseUrl: string): void {
	halveWindow(baseUrl);
}

/** The value of x-ratelimit-remaining-requests, tolerating absence and
 * unparseable values — a missing capacity hint never invents one
 * (spec §2). ≤ 1 means the next burst meets the wall. */
function readNearCap(value: string | null | undefined): boolean {
	if (value === undefined || value === null || value === '') return false;
	const n = Number(value);
	return Number.isInteger(n) && n <= 1;
}

/** Case-insensitive lookup for the SDK's response-headers record. */
function nearCapSignal(headers: Record<string, string> | undefined): boolean {
	if (headers === undefined) return false;
	const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-ratelimit-remaining-requests');
	return key === undefined ? false : readNearCap(headers[key]);
}

function pacingAdmits(baseUrl: string): boolean {
	return (activeByBase.get(baseUrl) ?? 0) < paceWindow(baseUrl);
}

function admitFor(baseUrl: string): void {
	activeByBase.set(baseUrl, (activeByBase.get(baseUrl) ?? 0) + 1);
}

function pump(): void {
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
	if (pacingAdmits(baseUrl) && (cooldowns.get(baseUrl) ?? 0) <= Date.now()) {
		admitFor(baseUrl);
		waiter.run();
		return promise;
	}
	queue.push(waiter);
	return promise;
}

function release(baseUrl: string): void {
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
/** One transport attempt either yields the model text plus the response
 * headers (for the proactive capacity read, issue #104) — and whether the
 * answer carried reasoning (the effort probe's behavioral read, issue
 * #107) — or throws. */
type AttemptResult =
	| {
			ok: true;
			text: string;
			headers: Record<string, string> | undefined;
			reasoningObserved: boolean;
	  }
	| { ok: false; err: unknown };

async function textAttempt(
	args: CallLLMArgs,
	signal: AbortSignal,
	probeSelf = false
): Promise<{ text: string; headers: Record<string, string> | undefined; reasoningObserved: boolean }> {
	const result = await generateText({
		model: buildModel(args),
		system: args.system,
		messages: args.messages,
		temperature: args.temperature,
		abortSignal: signal,
		maxRetries: 0,
		providerOptions: reasoningProviderOptions(args, probeSelf)
	});
	// Reasoning surfaces as content parts or only in usage accounting —
	// either means the endpoint kept thinking despite being asked for low.
	const reasoningObserved =
		result.reasoning.length > 0 ||
		(result.usage?.outputTokenDetails?.reasoningTokens ?? 0) > 0;
	return { text: result.text, headers: result.response?.headers, reasoningObserved };
}
/** Caller abort beats the attempt timeout; both end the attempt unretried. */
function attemptSignal(args: CallLLMArgs): AbortSignal {
	const signals: AbortSignal[] = [AbortSignal.timeout(limits.timeoutMs)];
	if (args.signal) signals.push(args.signal);
	return AbortSignal.any(signals);
}

/** Shared retry loop for non-streaming calls: acquire → attempt → classify →
 * cooldown/backoff → retry. 429 waits happen in acquire (the cooldown), so a
 * retrying call re-queues behind the same parking as everyone else.
 * `probeSelf` marks the effort probe's own call (issue #107): it must carry
 * the param unconditionally and must not re-enter the gate. */
async function callLLMInner(
	args: CallLLMArgs,
	probeSelf: boolean
): Promise<{ text: string; reasoningObserved: boolean }> {
	await primeSecrets(args.provider.apiKey);
	// Interpret lanes (issue #107): the first low-effort call for this model
	// awaits the endpoint's behavioral verdict. The lane holds NO slot while
	// waiting — the probe queues through the same acquire as everyone else.
	if (args.reasoningEffort === 'low' && !probeSelf) {
		await reasoningEffortSupported(args.provider, args.signal);
	}
	for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
		await acquire(args.provider.baseUrl, args.signal);
		const startMs = Date.now();
		const signal = attemptSignal(args);
		let outcome: AttemptResult;
		try {
			outcome = { ok: true, ...(await textAttempt(args, signal, probeSelf)) };
		} catch (err) {
			outcome = { ok: false, err };
		}
		release(args.provider.baseUrl);
		if (outcome.ok) {
			recordSuccess(args.provider.baseUrl);
			// Proactive shave (issue #104): the clean answer counts toward
			// growth either way; when its header says ≤ 1 request of account
			// headroom remains, the NEXT admissions shrink — no cooldown,
			// the endpoint has not said stop.
			if (nearCapSignal(outcome.headers)) recordNearLimit(args.provider.baseUrl);
			return outcome;
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
}

export const callLLM: CallLLM = async (args) => (await callLLMInner(args, false)).text;

/** Streaming arm (issue #104): the slot is held for the stream's ENTIRE
 * lifetime — the account-level limiter on a LiteLLM-style proxy counts
 * OPEN requests server-side, so releasing at first byte let 4 decoding
 * streams + 4 fresh requests hit the endpoint at once (the measured 429
 * storm). Each attempt acquires once and releases exactly once, in the
 * per-attempt finally, fired however the generator finishes — normal end,
 * throw, retry, or consumer break/.return(). A failure before the first
 * byte retries through the same rules as callLLM — and a backing-off
 * stream holds NO slot: the finally releases before the cooldown/
 * backoff wait. A mid-stream failure surfaces honestly (spec §2) as a
 * scrubbed GatewayError. */

/** Classify a failed streaming attempt and steer: scrub + record + either
 * throw-honestly or decide how the retry waits. Pure classify-and-steer —
 * it never touches the slot (the caller's per-attempt finally owns that,
 * issue #104). Returns null when a 429 armed the endpoint's cooldown (the
 * re-acquire parks there); otherwise the per-call backoff the caller
 * sleeps AFTER the release, so a backing-off stream never holds a slot. */
async function drainAttempt(
	args: CallLLMArgs,
	attempt: number,
	startMs: number,
	err: unknown
): Promise<number | null> {
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
		return null;
	}
	return waitMs(status, err, attempt);
}

export const streamLLM = async function* (args: CallLLMArgs): AsyncIterable<string> {
	await primeSecrets(args.provider.apiKey);
	// Same one-time verdict as callLLM (issue #107): the streamed fill lanes
	// hold their slot for the stream's WHOLE lifetime, so an uncapped
	// reasoning model burns double — hidden tokens AND open-request time.
	if (args.reasoningEffort === 'low') {
		await reasoningEffortSupported(args.provider, args.signal);
	}
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
		// Retry steering (issue #104): the try body never `continue`s the
		// attempts loop — a labeled continue from inside the try jumps PAST
		// the post-finally backoff sleep, and a skipped backoff is a tight
		// retry loop manufacturing the exact 429 storms this issue exists
		// to prevent. Retry paths set `backoffMs` and fall out of the try;
		// the finally releases the slot, THEN the sleep runs, THEN the next
		// attempt acquires fresh — only live streams hold slots.
		let backoffMs: number | null = null;
		try {
			const stream = streamText({
				model: buildModel(args),
				system: args.system,
				messages: args.messages,
				temperature: args.temperature,
				abortSignal: args.signal
					? AbortSignal.any([args.signal, abortCtrl.signal])
					: abortCtrl.signal,
				maxRetries: 0,
				providerOptions: reasoningProviderOptions(args, false)
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
				let part: TextStreamPart<ToolSet> | undefined;
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
						return; // empty response — nothing to interpret, no lie to tell (the finally frees the slot)
					}
					part = first.value;
				} catch (err) {
					backoffMs = await drainAttempt(args, attempt, startMs, err);
					break;
				}
				if (part === undefined) {
					// Unreachable safety (first.done was false, so part was
					// assigned) — belt-and-braces retry; the per-attempt
					// finally frees the slot either way.
					break;
				}
				if (part.type === 'error') {
					backoffMs = await drainAttempt(args, attempt, startMs, part.error);
					break;
				}
				if (part.type !== 'text-delta') continue; // protocol part — keep reading

				// First byte = a successful attempt for the pacing window
				// (issue #64): the endpoint answered. The slot STAYS held for
				// the stream's whole lifetime (issue #104) — the endpoint
				// counts open requests server-side.
				recordSuccess(args.provider.baseUrl);
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
					else if (next.value.type === 'finish-step') {
						// Proactive capacity read (issue #104): the step's
						// response headers arrive while the slot is still held —
						// when the proxy says ≤ 1 request of account headroom
						// remains, what the NEXT admissions allow shrinks (this
						// stream runs to its end regardless). Other protocol
						// parts stay ignored.
						if (nearCapSignal(next.value.response.headers))
							recordNearLimit(args.provider.baseUrl);
					} else if (next.value.type === 'error') {
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
			// (A 'steer' break falls through to the finally: release, then the
			// backoff sleep below, then the next attempt acquires fresh.)
		} finally {
			// Settle the abandoned iterator first (its pending next() resolves
			// done — silence; decision 2026-09-17), THEN kill the fetch, THEN
			// free the slot — exactly once per acquire, however the attempt
			// exits: normal end, first-byte retry, honest throw, or consumer
			// break (issue #104: a dead stream must never leak admission).
			// Reason-carrying cleanup: the kill that ends a first-byte-timeout
			// or mid-stream-silence fetch must not read as an anonymous reason —
			// downstream listeners and DevTools show signal.reason verbatim.
			try {
				await drainIterator();
				abortCtrl.abort(callerReason(args.signal) ?? new DOMException('stream cleaned up (first-byte timeout, retry, or consumer exit)', 'AbortError')); // never leave a first-byte-timeout stream in flight
			} finally {
				release(args.provider.baseUrl);
			}
		}
		// The retry's own backoff sleeps AFTER the release above — the slot
		// belongs to live streams only (issue #104). A 429 instead parks the
		// next acquire in the endpoint's cooldown (drainAttempt returned
		// null — nothing to sleep here). The `!` is sound: nothing between
		// the check and the call can reassign backoffMs, and the finally
		// only releases the slot.
		if (backoffMs !== null) await sleep(backoffMs, args.signal);
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
			if (response.ok) {
				recordSuccess(baseUrl);
				// Same proactive shave as the callLLM arm (issue #104) —
				// Headers.get() is already case-insensitive.
				if (readNearCap(response.headers.get('x-ratelimit-remaining-requests')))
					recordNearLimit(baseUrl);
			}
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
