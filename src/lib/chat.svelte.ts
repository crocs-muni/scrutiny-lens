/**
 * Chat session store (issue #30, spec §11 step 4) — the conversation
 * orchestrator for one session at a time.
 *
 * Lifecycle honesty mirrors the investigation store (spec §8): navigation
 * away, session switch, and session close all abort the in-flight stream;
 * a stale async completion can never mix frames into a newer conversation
 * (the hydrate token).
 *
 * Rulings carried (docs/adr/0002, 0003):
 * - grounding set = the session's full admitted events (never facet-visible),
 * - one registry per conversation so citation numbers and color pairing are
 *   stable across turns and reloads (pins persist next to the transcript),
 * - persistence is record-shaped: only SETTLED frames land in IndexedDB —
 *   a question persists together with its answer; errors and aborted turns
 *   persist nothing.
 */

import { chatground, type ChatCitation, type ClaimsSummary, type StreamLLM } from '$lib/ai/agents/chat';
import { createCitationRegistry, type CitationRegistry } from '$lib/ai/citationRegistry';
import { scrubAnswer } from '$lib/chat/answer';
import type { NostrEvent } from '$lib/fabric';
import type { ProviderOverrideInput } from '$lib/ai/provider';
import {
	getChatPins,
	listChatMessages,
	putChatTurn,
	type PersistedChatCitation,
	type PersistedChatMessage
} from '$lib/db';

/** In-memory transcript record — shape-identical to the persisted one, so a
 * settled message is stored as-is (ADR 0003's record semantics). */
export type ChatMessage = PersistedChatMessage;

/** The in-flight turn: question on screen immediately, answer streaming. */
interface LiveTurn {
	question: string;
	userId: string;
	raw: string;
}

/** A settled transport failure (ADR 0003: never persisted). `partial` is
 * the raw streamed-so-far text — ruling 6: partial prose stays on screen
 * after a provider failure, marker-suppressed and unstyled (no shimmer, no
 * pill: verification never ran, so nothing may hint at trust). */
export interface ChatError {
	question: string;
	message: string;
	partial?: string;
}

export interface SendContext {
	events: NostrEvent[];
	rootSummary: string;
	provider?: ProviderOverrideInput;
	/** Test seam — forwarded to chatground. */
	streamLLM?: StreamLLM;
}

/** SSE frame parser for chatground's stream — the reader halves are copied
 * from no one: the store needs INCREMENTAL frames (deltas must land as they
 * arrive), which the test helper drains whole. */
async function* readFrames(
	stream: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf('\n\n')) >= 0) {
			const block = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const line = block.split('\n').find((l) => l.startsWith('data: '));
			if (line) yield JSON.parse(line.slice(6)) as Record<string, unknown>;
		}
	}
}

function toPersistedCitation(c: ChatCitation): PersistedChatCitation {
	const out: PersistedChatCitation = {
		n: c.n,
		eventId: c.eventId,
		quote: c.quote,
		colorIndex: c.colorIndex
	};
	if (c.span !== undefined) out.span = c.span;
	if (c.nodeTitle !== undefined) out.nodeTitle = c.nodeTitle;
	return out;
}

class Chat {
	/** Active session id; null while no session is open. */
	sessionId = $state<string | null>(null);
	messages = $state<ChatMessage[]>([]);
	registry = $state<CitationRegistry>(createCitationRegistry());
	live = $state<LiveTurn | null>(null);
	error = $state<ChatError | null>(null);
	sending = $state(false);
	/** Set when content lands while the column may be collapsed; the page
	 * clears it (unread dot on the stub, ChatColumn anatomy). */
	unseen = $state(false);
	/** The current send's grounding set — the shimmer pins eager citation
	 * numbers against it, and ONLY against it (a fabricated id must never
	 * consume a number). Cleared by hydrate/reset with the transcript. */
	grounding = $state<NostrEvent[]>([]);

	private abortCtl: AbortController | undefined;
	/** Stale-load guard: hydrate async applies only while this token is
	 * current — same seam as the investigation run guard. */
	private hydrateToken = 0;
	/** Per-session monotonic message clock: wall-clock ties sort
	 * nondeterministically through the sessionId index, so createdAt only
	 * counts up from here (hydrate seeds it from the stored transcript). */
	private lastAt = 0;

	/** Restore a session's transcript and registry numbering. */
	async hydrate(sessionId: string): Promise<void> {
		if (this.sessionId === sessionId) return;
		this.abortInFlight();
		const token = ++this.hydrateToken;
		this.sessionId = sessionId;
		this.messages = [];
		this.grounding = [];
		this.lastAt = 0;
		this.error = null;
		const registry = createCitationRegistry();
		this.registry = registry;

		const [pins, rows] = await Promise.all([getChatPins(sessionId), listChatMessages(sessionId)]);
		if (this.hydrateToken !== token) return;
		for (const eventId of pins?.pins ?? []) registry.next(eventId);
		this.messages = rows;
		this.lastAt = rows.reduce((max, m) => Math.max(max, m.createdAt), 0);
	}

	/** No session open: drop the conversation and any in-flight stream. */
	reset(): void {
		this.abortInFlight();
		this.hydrateToken++;
		this.lastAt = 0;
		this.sessionId = null;
		this.messages = [];
		this.grounding = [];
		this.registry = createCitationRegistry();
		this.error = null;
	}

	abortInFlight(): void {
		this.abortCtl?.abort();
		this.abortCtl = undefined;
		this.sending = false;
		this.live = null;
	}

	/** Ordered pinned event ids — citation number n owns pins[n-1]. */
	private pins(): string[] {
		const out: string[] = [];
		for (let i = 1; i <= this.registry.size(); i++) {
			const id = this.registry.eventIdFor(i);
			if (id !== undefined) out.push(id);
		}
		return out;
	}

	async send(question: string, ctx: SendContext): Promise<void> {
		const sessionId = this.sessionId;
		if (sessionId === null || this.sending) return;
		const trimmed = question.trim();
		if (trimmed === '') return;

		this.sending = true;
		this.error = null;
		this.grounding = ctx.events;
		const userId = crypto.randomUUID();
		const liveSeed: LiveTurn = { question: trimmed, userId, raw: '' };
		this.live = liveSeed;
		// $state proxy fork (trap-sweep:RuneSemanticsScout): this.live now
		// holds a PROXY of the raw literal — its set-trap never writes back
		// to the raw object, so `live.raw += ...` was invisible to the
		// chat column's proxy reads (frozen pending shimmer), and the
		// trailing identity guard `this.live === live` compared proxy vs
		// raw and NEVER fired, leaving the dead live bubble forever.
		// Mutate and compare through the proxy, the canonical idiom.
		const live = this.live;
		if (live === null) return;
		const controller = new AbortController();
		this.abortCtl = controller;

		const createdAt = Math.max(Date.now(), this.lastAt + 1);
		const history = this.messages
			.filter((m) => m.content !== '' || m.availableContext !== undefined)
			.map((m) => ({
				role: m.role,
				// Ungrounded answers carried no content; the model's own prose
				// about the session is the honest history entry.
				content: m.content !== '' ? m.content : `(no answer — the session contains: ${m.availableContext ?? ''})`
			}));

		try {
			const frames = readFrames(
				chatground({
					question: trimmed,
					history,
					groundingEvents: ctx.events,
					rootSummary: ctx.rootSummary,
					provider: ctx.provider,
					registry: this.registry,
					abortSignal: controller.signal,
					...(ctx.streamLLM ? { streamLLM: ctx.streamLLM } : {})
				})
			);
			for await (const f of frames) {
				// A transport that FINISHES after an abort (fake or slow) still
				// delivers frames — an aborted turn must never settle (ADR
				// 0003: aborted turns persist nothing).
				if (controller.signal.aborted) break;
				if (f.type === 'delta') {
					live.raw = `${live.raw}${f.text as string}`;
					continue;
				}
				if (f.type === 'error') {
					this.error = {
						question: trimmed,
						message: String(f.message),
						...(live.raw !== '' ? { partial: live.raw } : {})
					};
					continue;
				}
				// final — settle, scrub, persist (user + answer together so a
				// transcript never holds an orphaned question).
				const userMessage: ChatMessage = {
					id: userId,
					sessionId,
					role: 'user',
					content: trimmed,
					kind: 'answer',
					createdAt
				};
				const assistantAt = createdAt + 1;
				this.lastAt = assistantAt;
				let assistant: ChatMessage;
				if (f.kind === 'ungrounded') {
					assistant = {
						id: crypto.randomUUID(),
						sessionId,
						role: 'assistant',
						content: '',
						availableContext: String(f.availableContext),
						kind: 'ungrounded',
						createdAt: assistantAt
					};
				} else {
					const settled = scrubAnswer(
						String(f.content),
						(f.citations ?? []) as ChatCitation[]
					);
					assistant = {
						id: crypto.randomUUID(),
						sessionId,
						role: 'assistant',
						content: settled.content,
						citations: settled.citations.map(toPersistedCitation),
						...(f.claimsSummary ? { claimsSummary: f.claimsSummary as ClaimsSummary } : {}),
						kind: 'answer',
						createdAt: assistantAt
					};
				}
				this.messages = [...this.messages, userMessage, assistant];
				this.unseen = true;
				// Settle must MEAN durable AND atomic (ADR 0003's record
				// semantics): question, answer and pins land in one
				// transaction — a quota/crash between separate puts would
				// leave a transcript with an orphaned question or pins that
				// renumber the past. attempt() still degrades a hard IDB
				// failure to memory-only.
				await putChatTurn({
					sessionId,
					messages: [userMessage, assistant],
					pins: this.pins()
				});
			}
		} catch (err) {
			if (controller.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError') {
				// Intentional disconnect — the live turn dies quietly (ADR 0003:
				// aborted turns persist nothing).
			} else {
				this.error = {
					question: trimmed,
					message: String((err as Error)?.message ?? err),
					...(live.raw !== '' ? { partial: live.raw } : {})
				};
			}
		} finally {
			if (this.abortCtl === controller) this.abortCtl = undefined;
			this.sending = false;
			if (this.live === live) this.live = null;
		}
	}
}

export const chat = new Chat();

/** Test seam — same shape as resetShell/resetInvestigation. */
export function resetChat(): void {
	chat.reset();
	chat.unseen = false;
}

/* PersistedChatMessage shape note: `availableContext` appears on ungrounded
 * records. It is declared on the db record — see $lib/db. */
