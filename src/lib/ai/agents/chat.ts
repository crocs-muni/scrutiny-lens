/**
 * W5 · Chat agent — grounded chat over the session's admitted events, REAL SSE streaming.
 *
 * Pipeline:
 *   1. System prompt: ground EVERY claim to a visible node with the inline
 *      marker `[N]{"eventId":"<id>","quote":"<verbatim>"}`; if the question is
 *      not answerable from the visible nodes, emit the single-line sentinel
 *      `UNGROUNDED {"availableContext":"…"}` — never fabricate.
 *   2. Stream raw model text (streamText → textStream; injectable via
 *      `streamLLM`). Deltas are forwarded as SSE frames as they arrive — only
 *      the ≤10-char sentinel-prefix ambiguity is ever buffered, never
 *      res.text()-style full buffering.
 *   3. On completion the accumulated content's markers are resolved through
 *      the per-session citation registry (stable numbers) and each quote is
 *      verifier-gated (extractedGate: verbatim / partial / extrapolatory).
 *      Unresolvable markers are dropped from the final content; extrapolatory
 *      citations stay but are marked unverified with support 'extrapolatory'.
 *   4. A single final SSE frame carries the resolved content, citations[],
 *      claimsSummary — emitted only after marker resolution.
 *
 * SSE frames emitted on the returned ReadableStream:
 *   data: {"type":"delta","text":"…"}
 *   data: {"type":"final","content":"…","citations":[…],"claimsSummary":{…}}
 *   data: {"type":"final","kind":"ungrounded","question":"…","availableContext":"…"}
 *   data: {"type":"error","message":"…"}
 *
 * Abort: the caller's abortSignal (client disconnect) is propagated into the
 * LLM call; cancelling the stream also aborts the call. Abort closes the
 * stream quietly — no error frame is emitted for an intentional disconnect.
 */

import { z } from 'zod';
import { streamLLM } from '../gateway';
import type { CallLLMArgs, LLMMessage } from '../output';
import { extractedGate, type ExtractionState } from '../verifier';
import {
	CITATION_SLOTS,
	createCitationRegistry,
	type Citation,
	type CitationRegistry
} from '../citationRegistry';
import { bestIdentifier } from '../projector';
import type { NostrEvent } from '../../fabric';
import {
	getProviderConfig,
	type ProviderConfig,
	type ProviderOverrideInput,
	NO_KEY_MESSAGE
} from '../provider';
import { buildSystemPrompt, DEFAULT_PROFILE } from '../prompts/vocabCcd';
/** Injectable streaming transport — yields raw model text chunks as they arrive. Throws on transport failure. */
export type StreamLLM = (args: CallLLMArgs) => AsyncIterable<string>;

/* ------------------------------------------------------------------ *
 * Grounding transport budget
 *
 * ADR 0002: the chat's CITABLE scope is the session's full admitted set —
 * never shrink it by facet filtering. That contract says nothing about the
 * wire: the model prompt is a single JSON blob, and shipping 250+ full
 * events (often north of a megabyte) blows past any streaming provider's
 * prompt-eval budget — on the default 30s first-byte gateway limit EVERY
 * answer on a large session died with "The operation timed out."
 * (2026-09-17, ROCA-run chat). The trim below is a TRANSPORT budget, not
 * a semantic scope change: matched-first selection, count- and byte-capped,
 * and disclosed in the system prompt so the model answers honestly ("not
 * in the provided grounding") instead of guessing about events it never
 * saw. Per-event content is suffix-truncated, so any quote the model emits
 * remains a verbatim prefix-substring of the on-screen event (contract 3).
 * ------------------------------------------------------------------ */
/** Grounding events per prompt — enough for a multi-subject question, small
 * enough to keep the first byte within a 30s budget on hosted providers. */
const GROUNDING_MAX_EVENTS = 40;
/** Hard byte ceiling for the serialized grounding block. */
const GROUNDING_MAX_BYTES = 96 * 1024;
/** Per-event content cap; truncation is a prefix slice (quotes stay
 * verbatim-valid against the full on-screen event). */
const EVENT_CONTENT_MAX_CHARS = 1500;

/** matchesFulltext grammar (single owner: $lib/pipeline/index.ts) — local
 * copy because ai/ MUST NOT import pipeline/ for a four-line predicate. */
function eventMatches(event: NostrEvent, terms: string[]): boolean {
	const haystack = (event.content + ' ' + event.tags.flat().join(' ')).toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

/** Question terms: lowercase alnum runs ≥3 chars, deduped, capped — a chat
 * question is short; a pathological paste must not become a 200-term AND. */
function questionTerms(question: string): string[] {
	const terms: string[] = [];
	for (const m of question.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) {
		if (!terms.includes(m[0])) terms.push(m[0]);
		if (terms.length >= 8) break;
	}
	return terms;
}

/** Select the transport-bounded grounding subset: question-matched events
 * first (all terms AND-matched, like the pipeline's own fulltext), then the
 * remainder in session order, until either cap trips. */
export function selectGrounding(
	events: NostrEvent[],
	question: string
): { kept: NostrEvent[]; total: number; matched: number } {
	const terms = questionTerms(question);
	const matched = terms.length > 0 ? events.filter((e) => eventMatches(e, terms)) : [];
	const rest = matched.length > 0 ? events.filter((e) => !matched.includes(e)) : events;
	const ordered = [...matched, ...rest];
	const kept: NostrEvent[] = [];
	let bytes = 0;
	for (const event of ordered) {
		// Size the SHIPPED wire form (truncated content) — a single raw event
		// larger than the byte budget must be truncated-in, never excluded:
		// excluding a question-matched event would silently narrow the scope
		// the disclosure line claims.
		const size = JSON.stringify({
			eventId: event.id,
			tags: event.tags,
			content: event.content.slice(0, EVENT_CONTENT_MAX_CHARS)
		}).length;
		if (kept.length >= GROUNDING_MAX_EVENTS || bytes + size > GROUNDING_MAX_BYTES) break;
		kept.push(event);
		bytes += size;
	}
	return { kept, total: events.length, matched: matched.length };
}

export interface ChatHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface ChatGroundOptions {
	question: string;
	history: ChatHistoryMessage[];
	/** Grounding set: the events the chat may cite. Issue #30 / ADR 0002:
	 * this is the session's full ADMITTED set — facet filtering must never
	 * shrink what the chat may say (renamed from `visibleEvents`). */
	groundingEvents: NostrEvent[];
	rootSummary: string;
	profile?: string;
	provider?: ProviderOverrideInput;
	abortSignal?: AbortSignal;
	/** Citation registry. Pass a conversation-scoped registry so citation
	 * numbers (and their color pairing) stay stable across turns (ADR 0003);
	 * a fresh per-call registry is the default for one-shot callers. */
	registry?: CitationRegistry;
	/** Test seam — chunked raw model text. Defaults to the streamText transport. */
	streamLLM?: StreamLLM;
}

/** Resolved citation in a final chat frame (view-models.md §3.7). */
export interface ChatCitation extends Citation {
	/** Computed at resolve-time by the verifier — never model opinion. */
	support: ExtractionState;
	status: 'resolved';
	/** Deterministic palette slot: (n - 1) % CITATION_PALETTE.length (registry I1). */
	colorIndex: number;
}

export interface ClaimsSummary {
	total: number;
	verbatim: number;
	partial: number;
	extrapolatory: number;
}

/* ------------------------------------------------------------------ *
 * SSE helpers
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

function frame(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/* ------------------------------------------------------------------ *
 * Marker protocol
 * ------------------------------------------------------------------ */

/** `[N]{"eventId":"…","quote":"…"}` — one JSON object, no nested braces.
 * Single owner of the raw marker grammar: the live stream parser
 * ($lib/chat/streamParse) re-exports and matches against THIS so the
 * pending-shimmer surface and the settle gate can never silently diverge
 * (standards review P2). */
export const MARKER = /\[(\d+)\]\s*\{([^{}]*)\}/g;

const markerPayloadSchema = z.object({
	eventId: z.string().min(1),
	quote: z.string()
});

interface ResolvedMarker {
	/** Full matched marker text (for replacement). */
	raw: string;
	citation: ChatCitation;
}

/* ------------------------------------------------------------------ *
 * Grounding instructions
 * ------------------------------------------------------------------ */

const UNGROUNDED_SENTINEL = 'UNGROUNDED';

const GROUNDING_INSTRUCTIONS = [
	// ADR 0002: the grounding set below is the session's admitted events, not a
	// view-filtered subset — the wording must not resurrect "visible nodes".
	'You are the SCRUTINY chat agent. Answer ONLY from the session events supplied in the user message — never from prior knowledge.',
	'',
	'Rules:',
	'1. Ground EVERY factual claim to a session event using the inline marker syntax: [N]{"eventId":"<event id>","quote":"<short quote>"}. N counts citations starting at 1.',
	'2. The quote MUST be copied verbatim from the event content (a contiguous subset is acceptable). If you cannot quote it, do not make the claim.',
	'3. Never fabricate event ids, identifiers, or quotes.',
	`4. If the question cannot be answered from the session events, reply with EXACTLY one line: ${UNGROUNDED_SENTINEL} {"availableContext":"<what the session does contain>"} — no other text.`
].join('\n');

/* ------------------------------------------------------------------ *
 * Default streaming transport
 * ------------------------------------------------------------------ */

/** Gateway streaming arm (issue #53): shares the gateway's FIFO slots and
 * per-baseUrl cooldown with the non-streaming lanes. Structurally identical
 * to StreamLLM (yields raw model text chunks; throws on transport failure). */
const defaultStreamLLM: StreamLLM = streamLLM;

/* ------------------------------------------------------------------ *
 * Final parse: resolve markers through the registry + verifier
 * ------------------------------------------------------------------ */

function nodeTitleOf(event: NostrEvent): string {
	return (bestIdentifier(event) ?? event.content.split('\n')[0].trim()).slice(0, 80);
}

function resolveFinal(
	fullText: string,
	events: NostrEvent[],
	registry: CitationRegistry
): { content: string; citations: ChatCitation[]; claimsSummary?: ClaimsSummary } {
	const citations: ChatCitation[] = [];
	const summary: ClaimsSummary = { total: 0, verbatim: 0, partial: 0, extrapolatory: 0 };
	const replacements: Array<{ raw: string; replacement: string }> = [];

	for (const match of fullText.matchAll(MARKER)) {
		const raw = match[0];
		const payload = markerPayloadSchema.safeParse(
			(() => {
				try {
					return JSON.parse(`{${match[2]}}`);
				} catch {
					return undefined;
				}
			})()
		);

		let resolvedCitation: ChatCitation | undefined;
		if (payload.success) {
			const event = events.find((e) => e.id === payload.data.eventId);
			const res = registry.resolve(payload.data.eventId, events, payload.data.quote, event ? nodeTitleOf(event) : undefined);
			if (res.ok && event) {
				const gate = extractedGate(payload.data.quote, event.content);
				resolvedCitation = {
					...res.citation,
					support: gate.state,
					verified: gate.state !== 'extrapolatory',
					status: 'resolved',
					colorIndex: (res.citation.n - 1) % CITATION_SLOTS
				};
			}
		}

		if (resolvedCitation) {
			citations.push(resolvedCitation);
			summary.total += 1;
			summary[resolvedCitation.support] += 1;
			// Canonical renumber: the registry's stable [N], not the model's.
			replacements.push({ raw, replacement: `[${resolvedCitation.n}]` });
		} else {
			// Unresolvable → drop the marker, swallowing one adjacent space so no
			// orphan whitespace remains. Whitespace elsewhere is literal content
			// (indent-preserved blocks, hard breaks) — never collapse globally.
			const precededBySpace = fullText.slice(0, match.index ?? 0).endsWith(' ');
			replacements.push({ raw: precededBySpace ? ` ${raw}` : raw, replacement: '' });
		}
	}

	const content = replacements.reduce((acc, r) => acc.split(r.raw).join(r.replacement), fullText);
	return {
		content,
		citations,
		claimsSummary: citations.length > 0 ? summary : undefined
	};
}

/* ------------------------------------------------------------------ *
 * Ungrounded final frame
 * ------------------------------------------------------------------ */

const ungroundedPayloadSchema = z.object({
	availableContext: z.string().min(1),
});

function ungroundedFrame(
	question: string,
	fullText: string,
	rootSummary: string
): Uint8Array {
	const body = fullText.trimStart().slice(UNGROUNDED_SENTINEL.length).trimStart();
	const parsed = ungroundedPayloadSchema.safeParse(
		(() => {
			try {
				return JSON.parse(body);
			} catch {
				return undefined;
			}
		})()
	);
	const payload = parsed.success
		? parsed.data
		: // Honest degrade: never fabricate context; fall back to the root summary.
			{ availableContext: rootSummary };
	return frame({
		type: 'final',
		kind: 'ungrounded',
		question,
		availableContext: payload.availableContext
	});
}

/* ------------------------------------------------------------------ *
 * chatground
 * ------------------------------------------------------------------ */

export function chatground(opts: ChatGroundOptions): ReadableStream<Uint8Array> {
	const internal = new AbortController();
	if (opts.abortSignal) {
		if (opts.abortSignal.aborted) internal.abort();
		else opts.abortSignal.addEventListener('abort', () => internal.abort(), { once: true });
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			void pump(controller);
		},
		cancel() {
			internal.abort();
		}
	});

	async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
		const done = () => {
			try {
				controller.close();
			} catch {
				/* stream already closed/cancelled */
			}
		};
		const fail = (message: string) => {
			try {
				controller.enqueue(frame({ type: 'error', message }));
			} catch {
				/* stream already closed/cancelled */
			}
			done();
		};

		try {
			const provRes = getProviderConfig(opts.provider);
			if (!provRes.ok) {
				return fail(
					provRes.kind === 'no_key'
						? `no_key: ${NO_KEY_MESSAGE}`
						: `invalid_request: ${provRes.issues.join('; ')}`
				);
			}
			const provider: ProviderConfig = provRes.config;
			const profile = opts.profile ?? DEFAULT_PROFILE;
			const stream = opts.streamLLM ?? defaultStreamLLM;

			const system = buildSystemPrompt({ profile, extra: GROUNDING_INSTRUCTIONS });
			// Transport-bounded grounding (block comment above): full set stays
			// citable ONLY when it fits; otherwise matched-first, disclosed.
			const grounding = selectGrounding(opts.groundingEvents, opts.question);
			const nodeList = grounding.kept.map((e) => ({
				eventId: e.id,
				tags: e.tags,
				content:
					e.content.length > EVENT_CONTENT_MAX_CHARS
						? `${e.content.slice(0, EVENT_CONTENT_MAX_CHARS)}…[TRUNCATED]`
						: e.content
			}));
			const trimmed = grounding.kept.length < grounding.total;
			const messages: LLMMessage[] = [
				...opts.history.map((h) => ({ role: h.role, content: h.content })),
				{
					role: 'user',
					content: [
						`Graph root: ${opts.rootSummary}`,
						...(trimmed
							? [
									`Grounding scope: ${grounding.kept.length} of ${grounding.total} session events provided (question-matched first; ${grounding.matched} matched). The rest were omitted to fit the transport budget — treat anything outside the provided set as unavailable and say so when asked.`
								]
							: []),
						`Session events: ${JSON.stringify(nodeList)}`,
						`Question: ${opts.question}`
					].join('\n')
				}
			];

			// Ground truth accumulator; delta emission only waits on the sentinel ambiguity.
			let full = '';
			let locked = false;
			let ungrounded = false;

			const iterable = stream({
				provider,
				system,
				messages,
				temperature: 0.2,
				signal: internal.signal
			});

			for await (const chunk of iterable) {
				full += chunk;
				if (ungrounded) continue;
				if (!locked) {
					const lead = full.trimStart();
					// Still a possible sentinel prefix → wait for the next chunk.
					if (lead.length < UNGROUNDED_SENTINEL.length && UNGROUNDED_SENTINEL.startsWith(lead)) continue;
					if (lead.startsWith(UNGROUNDED_SENTINEL)) {
						ungrounded = true;
						continue;
					}
					locked = true;
					controller.enqueue(frame({ type: 'delta', text: full }));
					continue;
				}
				controller.enqueue(frame({ type: 'delta', text: chunk }));
			}

			if (ungrounded) {
				controller.enqueue(ungroundedFrame(opts.question, full, opts.rootSummary));
				return done();
			}

			const registry = opts.registry ?? createCitationRegistry();
			const { content, citations, claimsSummary } = resolveFinal(
				full,
				opts.groundingEvents,
				registry
			);

			controller.enqueue(
				frame({
					type: 'final',
					content,
					citations,
					...(claimsSummary ? { claimsSummary } : {})
				})
			);
			done();
		} catch (err) {
			// Caller/client abort: close quietly — no error frame for intentional disconnects.
			if (internal.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError') {
				return done();
			}
			fail(String((err as Error)?.message ?? err));
		}
	}
}
