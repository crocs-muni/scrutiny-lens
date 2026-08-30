/**
 * W5 · Chat agent — grounded chat over the visible graph, REAL SSE streaming.
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

import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { CallLLMArgs, LLMMessage } from '../output';
import { extractedGate, type ExtractionState } from '../verifier';
import { createCitationRegistry, type Citation } from '../citationRegistry';
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

export interface ChatHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface ChatGroundOptions {
	question: string;
	history: ChatHistoryMessage[];
	visibleEvents: NostrEvent[];
	rootSummary: string;
	profile?: string;
	provider?: ProviderOverrideInput;
	abortSignal?: AbortSignal;
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

/** `[N]{"eventId":"…","quote":"…"}` — one JSON object, no nested braces. */
const MARKER = /\[(\d+)\]\s*\{([^{}]*)\}/g;

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
	'You are the SCRUTINY chat agent. Answer ONLY from the visible nodes supplied in the user message — never from prior knowledge.',
	'',
	'Rules:',
	'1. Ground EVERY factual claim to a visible node using the inline marker syntax: [N]{"eventId":"<event id>","quote":"<short quote>"}. N counts citations starting at 1.',
	'2. The quote MUST be copied verbatim from the event content (a contiguous subset is acceptable). If you cannot quote it, do not make the claim.',
	'3. Never fabricate event ids, identifiers, or quotes.',
	`4. If the question cannot be answered from the visible nodes, reply with EXACTLY one line: ${UNGROUNDED_SENTINEL} {"availableContext":"<what the graph does contain>"} — no other text.`
].join('\n');

/* ------------------------------------------------------------------ *
 * Default streaming transport
 * ------------------------------------------------------------------ */

async function* defaultStreamLLM({
	provider,
	system,
	messages,
	temperature,
	signal
}: CallLLMArgs): AsyncIterable<string> {
	const p = createOpenAICompatible({
		baseURL: provider.baseUrl,
		name: provider.name,
		apiKey: provider.apiKey
	});
	const result = streamText({
		model: p(provider.model),
		system,
		messages,
		temperature,
		abortSignal: signal
	});
	for await (const delta of result.textStream) yield delta;
}

/* ------------------------------------------------------------------ *
 * Final parse: resolve markers through the registry + verifier
 * ------------------------------------------------------------------ */

function nodeTitleOf(event: NostrEvent): string {
	return (bestIdentifier(event) ?? event.content.split('\n')[0].trim()).slice(0, 80);
}

function resolveFinal(
	fullText: string,
	events: NostrEvent[]
): { content: string; citations: ChatCitation[]; claimsSummary?: ClaimsSummary } {
	const registry = createCitationRegistry();
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
					colorIndex: (res.citation.n - 1) % 6
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
			const nodeList = opts.visibleEvents.map((e) => ({ eventId: e.id, tags: e.tags, content: e.content }));
			const messages: LLMMessage[] = [
				...opts.history.map((h) => ({ role: h.role, content: h.content })),
				{
					role: 'user',
					content: [
						`Graph root: ${opts.rootSummary}`,
						`Visible nodes: ${JSON.stringify(nodeList)}`,
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

			const { content, citations, claimsSummary } = resolveFinal(full, opts.visibleEvents);

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
