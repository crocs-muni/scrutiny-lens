// OpenAI-compatible AI stub for the harness server (`serve.ts` AiHandler).
//
// The app reaches it through the AI SDK's openai-compatible provider
// (`src/lib/ai/gateway.ts` buildModel): GET `<base>/models` feeds the
// settings combobox (exactly ONE model, so `nextAutoModel` picks it) and
// POST `<base>/chat/completions` carries every generateText/streamText call.
// The stub classifies each request into a lane, then replays a per-scene
// script. A scene with no script answers from the request itself (ids and
// content the app just sent), never from randomness or the wall clock.
//
// Wire shapes verified against scripts/smoke-gateway.ts (the SSE frame
// format) and the app's parsers: src/lib/ai/records.ts (KV records),
// src/lib/ai/agents/query.ts (translate), cards.ts (fill), nodes.ts (node
// fits) and chat.ts (citation markers). Fail-closed on an unknown lane: a
// harness that silently answers the wrong protocol would make a scene lie.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AiHandler } from './serve.ts';
import { T0 } from './time.ts';

/** The single model `/v1/models` advertises. */
export const HARNESS_MODEL = 'harness-model';

export type AiLane = 'probe' | 'translate' | 'fill' | 'nodes' | 'chat';

export interface AiCall {
	lane: AiLane;
	stream: boolean;
	model: string;
	system: string;
	messages: Array<{ role: string; content: string }>;
}

/** `hold` keeps the response open until the scene releases it, so mid-flight
 * states are reachable on purpose. */
export type AiReply =
	| { kind: 'ok'; content: string }
	| { kind: 'hold'; content: string }
	| { kind: 'status'; status: number; retryAfterSec?: number; message?: string }
	| { kind: 'network' };

export type AiStep = AiReply | ((call: AiCall) => AiReply);

/** Per-scene lane scripts, consumed in order; the last step repeats. */
export interface AiScript {
	lanes?: Partial<Record<AiLane, readonly AiStep[]>>;
}

export interface AiControl {
	/** Chat-completions requests seen (every theme's stub is fresh). */
	count(): number;
	/** Requests currently held open. */
	pending(): number;
	lanes(): Record<AiLane, number>;
	release(): void;
}

/** One line, whitespace-collapsed: KV values are line-oriented, and a record
 * value carrying a newline would split its block (records.ts splitBlocks). */
function line(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) : text;
}

function textOf(message: { content: unknown }): string {
	return typeof message.content === 'string' ? message.content : '';
}

/** The fill lane's user message is `[{id, content}, …]` (pipeline/cards.ts);
 * validate the two fields we read instead of trusting a cast. */
function isFillItem(item: unknown): item is { id: string; content: string } {
	if (item === null || typeof item !== 'object') return false;
	if (!('id' in item) || typeof item.id !== 'string') return false;
	if (!('content' in item) || typeof item.content !== 'string') return false;
	return true;
}

/** The last user message that parses as the fill lane's JSON array. The
 * re-prompt appends a text message, so the payload is not always last. */
function fillPayload(call: AiCall): Array<{ id: string; content: string }> {
	for (let i = call.messages.length - 1; i >= 0; i--) {
		const message = call.messages[i];
		if (message.role !== 'user') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(textOf(message));
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		const items = parsed.filter(isFillItem);
		if (items.length > 0) return items;
	}
	return [];
}

/** KV records quoting the event content the app just sent (title = first
 * line, snippet = the rest), so no text in a shot is invented. */
export function fillRecords(call: AiCall): string {
	return fillPayload(call)
		.map(({ id, content }) => {
			const [first = '', ...rest] = content.trim().split('\n');
			const title = clip(line(first) || line(content) || id, 120);
			const snippet = clip(line(rest.join(' ')) || line(content) || id, 300);
			return `id: ${id}\ntitle: ${title}\nsnippet: ${snippet}`;
		})
		.join('\n\n');
}

/** Truncated lane: every record but the last completes, the last is cut
 * mid-record — the app must salvage the head and leave the rest raw. */
export function fillRecordsTruncated(call: AiCall): string {
	const items = fillPayload(call);
	const complete = items.slice(0, -1).map(({ id, content }) => {
		const first = line(content.split('\n')[0] ?? content);
		return `id: ${id}\ntitle: ${clip(first || id, 120)}\nsnippet: ${clip(line(content), 300)}`;
	});
	const last = items.at(-1);
	const tail = last === undefined ? '' : `\n\nid: ${last.id}\ntitle: cut mid-rec`;
	return `${complete.join('\n\n')}${tail}`;
}

/** Node lane payload: `{"graphContext":…,"events":[{entityId,kind,content,…}]}`
 * sits between instruction lines (agents/nodes.ts), so slice from the object
 * line to the last brace. */
function nodePayload(call: AiCall): Array<{
	entityId: string;
	kind: string;
	content: string;
	tags: readonly unknown[];
}> {
	for (const message of call.messages) {
		const text = textOf(message);
		const at = text.indexOf('{"graphContext"');
		if (at === -1) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(at, text.lastIndexOf('}') + 1));
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== 'object' || !('events' in parsed)) continue;
		if (!Array.isArray(parsed.events)) continue;
		return parsed.events.filter(isNodeEvent);
	}
	return [];
}

function isNodeEvent(item: unknown): item is {
	entityId: string;
	kind: string;
	content: string;
	tags: readonly unknown[];
} {
	if (item === null || typeof item !== 'object') return false;
	if (!('entityId' in item) || typeof item.entityId !== 'string') return false;
	if (!('kind' in item) || typeof item.kind !== 'string') return false;
	if (!('content' in item) || typeof item.content !== 'string') return false;
	if (!('tags' in item) || !Array.isArray(item.tags)) return false;
	return true;
}

/** The vulnerability identifier the payload's own tags carry (the node lane
 * echoes `tags` per event), so the record never guesses one. */
function cveOf(tags: readonly unknown[]): string | undefined {
	for (const tag of tags) {
		if (!Array.isArray(tag)) continue;
		const [key, value] = tag;
		if (key === 'i' && typeof value === 'string' && /^cve:/i.test(value)) {
			return value.slice(value.indexOf(':') + 1);
		}
	}
	return undefined;
}

/** Node records built from the event content the app sent: titles are the
 * event's own first line, summaries a verbatim prefix (the quote gate in
 * agents/nodes.ts requires a ≥2-word contiguous match). */
export function nodeRecords(call: AiCall): string {
	return nodePayload(call)
		.map(({ entityId, kind, content, tags }) => {
			const first = line(content.split('\n')[0] ?? content);
			const head = `entityId: ${entityId}\ntitle: ${clip(first || entityId, 80)}`;
			if (kind === 'metadata') {
				return `${head}\ntypeToken: document\nmetaType: report\nlabel: ${clip(first || entityId, 70)}`;
			}
			if (kind === 'unknown') {
				return `${head}\ntypeToken: generic\nsummary: ${clip(line(content) || first || entityId, 120)}`;
			}
			if (kind === 'vulnerability') {
				const identifier = cveOf(tags);
				return `${head}\ntypeToken: software\nidentifier: ${identifier ?? entityId}\nidentifierKind: cve\nisRoot: false`;
			}
			return `${head}\ntypeToken: smartcard\nisRoot: false`;
		})
		.join('\n\n');
}

/** Lane from the prompt text the app sent. The system prompt is the app's
 * own constant per lane (query.ts, cards.ts, nodes.ts, chat.ts); the probe
 * (`Reply with exactly: ok`, gateway.ts reasoningEffortSupported) is the one
 * request with no system prompt. */
function classify(call: { system: string; messages: AiCall['messages'] }): AiLane {
	const last = call.messages.at(-1);
	if (last !== undefined && last.content === 'Reply with exactly: ok') return 'probe';
	if (call.system.includes('You are the SCRUTINY chat agent')) return 'chat';
	if (call.system.includes('security-asset interpretation card writer')) return 'fill';
	if (call.system.includes('Turn the user question into searches')) return 'translate';
	if (call.system.includes('Common Criteria vocabulary')) return 'nodes';
	// Fail closed: an unclassified request is harness drift, and a silently
	// plausible answer would let a scene screenshot a state it never built.
	throw new Error(`ai stub: unclassified request (system: ${call.system.slice(0, 60)}…)`);
}

/** Translate from the question the app sent: one free-text search of the
 * question's words. Scenes script their own value when it matters. */
function translateRecords(call: AiCall): string {
	const first = call.messages.find((message) => message.role === 'user');
	const question = textOf(first ?? { content: '' })
		.split('\n')
		.filter((part) => part.trim() !== '')
		.at(-1);
	return `kind: text\nvalue: ${clip(line(question ?? ''), 120)}`;
}

/** Default reply for a lane round the scene did not script. */
function defaultReply(call: AiCall): AiReply {
	switch (call.lane) {
		case 'probe':
			return { kind: 'ok', content: 'ok' };
		case 'translate':
			return { kind: 'ok', content: translateRecords(call) };
		case 'fill':
			return { kind: 'ok', content: fillRecords(call) };
		case 'nodes':
			return { kind: 'ok', content: nodeRecords(call) };
		case 'chat':
			// No chat scene without a script has anything true to say.
			return { kind: 'ok', content: 'UNGROUNDED {"availableContext":"the session events"}' };
	}
}

/** OpenAI-style SSE frames for one assistant message (smoke-gateway.ts's
 * format; `created` is the fixture epoch, not the wall clock). */
function sseFrames(content: string): string {
	const frame = (delta: Record<string, string>, finishReason: string | null): string =>
		`data: ${JSON.stringify({
			id: 'chatcmpl-harness',
			object: 'chat.completion.chunk',
			created: T0,
			model: HARNESS_MODEL,
			choices: [{ index: 0, delta, finish_reason: finishReason }]
		})}\n\n`;
	const chunks: string[] = [];
	const size = Math.max(1, Math.ceil(content.length / 5));
	for (let at = 0; at < content.length; at += size) chunks.push(content.slice(at, at + size));
	if (chunks.length === 0) chunks.push('');
	return [
		frame({ role: 'assistant' }, null),
		...chunks.map((chunk) => frame({ content: chunk }, null)),
		frame({}, 'stop'),
		'data: [DONE]\n\n',
	].join('');
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

/** The wire body's used fields (AI SDK openai-compatible request). Parsed
 * once so the handler reads typed values, not a cast. */
const ChatBody = z
	.object({
		model: z.string().optional(),
		stream: z.boolean().optional(),
		system: z.string().optional(),
		messages: z
			.array(z.object({ role: z.string(), content: z.unknown() }).passthrough())
			.optional()
	})
	.passthrough();

function json(res: ServerResponse, status: number, payload: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(payload));
}

/** Consume the lane's next scripted step; the last one repeats. */
function pickStep(
	steps: readonly AiStep[],
	cursors: Map<AiLane, number>,
	call: AiCall
): AiReply {
	const at = cursors.get(call.lane) ?? 0;
	cursors.set(call.lane, at + 1);
	const step = steps[Math.min(at, steps.length - 1)];
	if (step === undefined) return defaultReply(call);
	return typeof step === 'function' ? step(call) : step;
}

/* Scripted lane steps the scenes share (built from the request's own ids and
 * fixture content, never from randomness). */
export const okFill: AiStep = (call) => ({ kind: 'ok', content: fillRecords(call) });
export const okFillTruncated: AiStep = (call) => ({
	kind: 'ok',
	content: fillRecordsTruncated(call)
});
export const okNodes: AiStep = (call) => ({ kind: 'ok', content: nodeRecords(call) });
export const holdFill: AiStep = (call) => ({ kind: 'hold', content: fillRecords(call) });
/** Smoke-gateway.ts's junk line: a plausible refusal that carries no record. */
export const JUNK: AiStep = {
	kind: 'ok',
	content: 'I am sorry, I cannot help with that request.'
};

export function createAiStub(script: AiScript): { handler: AiHandler; control: AiControl } {
	const cursors = new Map<AiLane, number>();
	const counts: Record<AiLane, number> = { probe: 0, translate: 0, fill: 0, nodes: 0, chat: 0 };
	let total = 0;
	let inFlight = 0;
	let released = false;
	const held: Array<() => void> = [];

	function release(): void {
		released = true;
		for (const resume of held.splice(0)) resume();
	}

	async function awaitRelease(): Promise<void> {
		if (released) return;
		await new Promise<void>((resume) => held.push(resume));
	}

	const handler: AiHandler = async (req, res) => {
		const path = (req.url ?? '').split('?')[0];
		if (path === '/v1/models' && req.method === 'GET') {
			json(res, 200, {
				object: 'list',
				data: [{ id: HARNESS_MODEL, object: 'model', owned_by: 'harness' }]
			});
			return true;
		}
		if (path !== '/v1/chat/completions' || req.method !== 'POST') return false;
		let body: z.infer<typeof ChatBody>;
		try {
			const parsed = ChatBody.safeParse(JSON.parse(await readBody(req)));
			if (!parsed.success) {
				json(res, 400, { error: { message: 'harness: unexpected request shape' } });
				return true;
			}
			body = parsed.data;
		} catch {
			json(res, 400, { error: { message: 'harness: unparseable request body' } });
			return true;
		}
		const systemMessages: string[] = [];
		const messages: AiCall['messages'] = (body.messages ?? []).flatMap((message) => {
			if (typeof message.content !== 'string') return [];
			// The AI SDK sends generateText's `system` as a role:"system"
			// message (OpenAI wire shape), not as a top-level field; lane
			// classification reads it from there.
			if (message.role === 'system') {
				systemMessages.push(message.content);
				return [];
			}
			return [{ role: message.role, content: message.content }];
		});
		const base = {
			system: [body.system ?? '', ...systemMessages].filter((part) => part !== '').join('\n\n'),
			messages
		};
		let lane: AiLane;
		try {
			lane = classify(base);
		} catch (err) {
			// Fail closed (classify's own comment): answer 500, never a
			// plausible reply for a lane the harness does not know.
			json(res, 500, {
				error: { message: err instanceof Error ? err.message : String(err) }
			});
			return true;
		}
		const call: AiCall = {
			lane,
			stream: body.stream === true,
			model: body.model ?? '',
			...base
		};
		counts[call.lane] += 1;
		total += 1;
		const steps = script.lanes?.[call.lane];
		let reply: AiReply = steps === undefined ? defaultReply(call) : pickStep(steps, cursors, call);
		if (reply.kind === 'hold') {
			inFlight += 1;
			await awaitRelease();
			inFlight -= 1;
			reply = { kind: 'ok', content: reply.content };
		}
		if (reply.kind === 'network') {
			// A fetch that rejects before any response is the app's honest
			// "browser blocked" lane (records.ts kindOf).
			req.socket.destroy();
			return true;
		}
		if (reply.kind === 'status') {
			if (reply.retryAfterSec !== undefined) {
				res.setHeader('retry-after', String(reply.retryAfterSec));
			}
			json(res, reply.status, {
				error: { message: reply.message ?? `harness: status ${reply.status}`, type: 'server_error' }
			});
			return true;
		}
		if (call.stream) {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/event-stream');
			res.setHeader('cache-control', 'no-cache');
			res.end(sseFrames(reply.content));
			return true;
		}
		json(res, 200, {
			id: 'chatcmpl-harness',
			object: 'chat.completion',
			created: T0,
			model: HARNESS_MODEL,
			choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
		});
		return true;
	};

	return {
		handler,
		control: {
			count: () => total,
			pending: () => inFlight,
			lanes: () => ({ ...counts }),
			release
		}
	};
}