import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '$lib/server/fabric';
import type { CallLLMArgs } from '$lib/server/ai/output';
import { chatground, type StreamLLM } from '$lib/server/ai/agents/chat';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

/* ---------- helpers ---------- */

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

const EVENTS = [
	event('ev-prod', 'Infineon RSA library used in smartcards (ROCA).'),
	event('ev-vuln', 'ROCA: Return of Coppersmith Attack on RSA key generation.')
];

/** Streaming fake: yields the given chunks; records its args. */
function fakeStream(chunks: string[]): { stream: StreamLLM; calls: CallLLMArgs[] } {
	const calls: CallLLMArgs[] = [];
	const stream: StreamLLM = async function* (args) {
		calls.push(args);
		for (const c of chunks) yield c;
	};
	return { stream, calls };
}

interface Frame {
	type: string;
	[key: string]: unknown;
}

/** Drain an SSE ReadableStream into parsed frames — streaming reader, no res.text(). */
async function readFrames(stream: ReadableStream<Uint8Array>): Promise<Frame[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const frames: Frame[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf('\n\n')) >= 0) {
			const block = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const line = block.split('\n').find((l) => l.startsWith('data: '));
			if (line) frames.push(JSON.parse(line.slice(6)) as Frame);
		}
	}
	return frames;
}

function baseOpts(over: Partial<Parameters<typeof chatground>[0]> = {}): Parameters<typeof chatground>[0] {
	return {
		question: 'Which products are affected by ROCA?',
		history: [],
		visibleEvents: EVENTS,
		rootSummary: 'Infineon M7794 · ROCA exposure',
		provider: PROVIDER,
		callLLM: async () => 'never used', // followups injection stays offline
		...over
	};
}

/* ---------- SSE frame sequence ---------- */

describe('chatground — streaming frames', () => {
	it('emits delta×N then a final with resolved citations', async () => {
		const marker = '[1]{"eventId":"ev-prod","quote":"Infineon RSA library used in smartcards (ROCA)."}';
		const { stream } = fakeStream(['All three ', 'Infineon parts are bound to ROCA', marker]);
		const frames = await readFrames(chatground(baseOpts({ streamLLM: stream })));

		const types = frames.map((f) => f.type);
		expect(types.slice(0, -1).every((t) => t === 'delta')).toBe(true);
		expect(types).toHaveLength(frames.filter((f) => f.type === 'delta').length + 1);
		const final = frames[frames.length - 1];
		expect(final.type).toBe('final');
		expect(frames.filter((f) => f.type === 'delta').length).toBeGreaterThanOrEqual(1);

		// Final content: marker replaced by the canonical registry number.
		expect(final.content).toBe('All three Infineon parts are bound to ROCA[1]');

		const citations = final.citations as Array<Record<string, unknown>>;
		expect(citations).toHaveLength(1);
		const c = citations[0];
		expect(c.n).toBe(1);
		expect(c.eventId).toBe('ev-prod');
		expect(c.verified).toBe(true);
		expect(c.support).toBe('verbatim');
		expect(c.status).toBe('resolved');
		expect(c.colorIndex).toBe(0); // (1 - 1) % 6
		expect(c.span).toBe('Infineon RSA library used in smartcards (ROCA).');

		const summary = final.claimsSummary as Record<string, number>;
		expect(summary).toEqual({ total: 1, verbatim: 1, partial: 0, extrapolatory: 0 });
	});

	it('verifier classifies verbatim vs partial vs extrapolatory per citation', async () => {
		const content =
			'Vulnerable product [1]{"eventId":"ev-prod","quote":"Infineon RSA library used in smartcards"} ' +
			'bound to [2]{"eventId":"ev-vuln","quote":"According to sources ROCA: Return of Coppersmith Attack"} ' +
			'and [3]{"eventId":"ev-vuln","quote":"a fabricated severity rating of 9.8"}';
		const { stream } = fakeStream([content]);
		const frames = await readFrames(chatground(baseOpts({ streamLLM: stream })));
		const final = frames[frames.length - 1];
		expect(final.type).toBe('final');

		const citations = final.citations as Array<Record<string, unknown>>;
		expect(citations).toHaveLength(3);
		expect(citations[0].support).toBe('verbatim');
		expect(citations[0].verified).toBe(true);
		// blockquote-subset: only the trailing run matches → partial, still verified
		expect(citations[1].support).toBe('partial');
		expect(citations[1].verified).toBe(true);
		expect(citations[1].span).toBe('ROCA: Return of Coppersmith Attack');
		// nothing usable → extrapolatory, marked unverified (not dropped — it still points at a visible node)
		expect(citations[2].support).toBe('extrapolatory');
		expect(citations[2].verified).toBe(false);

		const summary = final.claimsSummary as Record<string, number>;
		expect(summary).toEqual({ total: 3, verbatim: 1, partial: 1, extrapolatory: 1 });
	});

	it('unresolvable markers are dropped from the final content', async () => {
		const content = 'Grounded [1]{"eventId":"ev-prod","quote":"Infineon RSA library"} and phantom [2]{"eventId":"ev-nope","quote":"nothing"}';
		const { stream } = fakeStream([content]);
		const frames = await readFrames(chatground(baseOpts({ streamLLM: stream })));
		const final = frames[frames.length - 1];
		expect(final.type).toBe('final');
		expect(final.content).toBe('Grounded [1] and phantom');
		expect(final.content).not.toContain('{"eventId"');
		const citations = final.citations as Array<Record<string, unknown>>;
		expect(citations).toHaveLength(1);
		expect(citations[0].eventId).toBe('ev-prod');
	});

	it('stable numbering in one message: same event keeps a single [N], registry pins follow order', async () => {
		const content =
			'A [1]{"eventId":"ev-vuln","quote":"ROCA: Return of Coppersmith Attack"} ' +
			'b [2]{"eventId":"ev-prod","quote":"Infineon RSA library"} ' +
			'c [3]{"eventId":"ev-vuln","quote":"RSA key generation"}';
		const { stream } = fakeStream([content]);
		const frames = await readFrames(chatground(baseOpts({ streamLLM: stream })));
		const final = frames[frames.length - 1];
		const citations = final.citations as Array<Record<string, unknown>>;
		// ev-vuln pinned first ([1] in reading order), ev-prod second; the third
		// marker reuses ev-vuln's number.
		expect(citations.map((c) => c.n)).toEqual([1, 2, 1]);
		expect(citations.map((c) => c.colorIndex)).toEqual([0, 1, 0]);
		expect(final.content).toBe('A [1] b [2] c [1]');
	});
});

/* ---------- ungrounded state ---------- */

describe('chatground — ungrounded', () => {
	it('unanswerable question returns a non-streaming UngroundedStateVM final frame', async () => {
		const { stream } = fakeStream([
			'UNGROUNDED {"availableContext":"Only certificate metadata is visible on this graph.","followUps":["Which products are bound to ROCA?","Show archived nodes."]}'
		]);
		const frames = await readFrames(
			chatground(baseOpts({ question: 'What is the weather?', streamLLM: stream }))
		);

		// No deltas, exactly one final frame.
		expect(frames.filter((f) => f.type === 'delta')).toHaveLength(0);
		expect(frames).toHaveLength(1);
		const final = frames[0];
		expect(final.type).toBe('final');
		expect(final.kind).toBe('ungrounded');
		expect(final.question).toBe('What is the weather?');
		expect(final.availableContext).toBe('Only certificate metadata is visible on this graph.');
		expect(final.followUps).toEqual(['Which products are bound to ROCA?', 'Show archived nodes.']);
	});

	it('malformed ungrounded payload degrades honestly to rootSummary + static follow-ups', async () => {
		const { stream } = fakeStream(['UNGROUNDED not json at all']);
		const frames = await readFrames(
			chatground(baseOpts({ question: 'Unanswerable thing', streamLLM: stream }))
		);
		expect(frames).toHaveLength(1);
		const final = frames[0];
		expect(final.kind).toBe('ungrounded');
		expect(final.availableContext).toBe('Infineon M7794 · ROCA exposure');
		expect((final.followUps as string[]).length).toBeGreaterThan(0);
	});
});

/* ---------- abort + errors ---------- */

describe('chatground — abort propagation', () => {
	it('forwards the abortSignal into the stream transport and aborts on cancel', async () => {
		const { stream, calls } = fakeStream(['This long answer', ' keeps going', ' and going']);
		const ctrl = new AbortController();
		const rs = chatground(baseOpts({ streamLLM: stream, abortSignal: ctrl.signal }));

		const reader = rs.getReader();
		await reader.read(); // first delta

		expect(calls).toHaveLength(1);
		expect(calls[0].signal).toBeDefined();
		expect(calls[0].signal?.aborted).toBe(false);

		ctrl.abort(new Error('client disconnect'));
		expect(calls[0].signal?.aborted).toBe(true);
		await reader.cancel();
	});

	it('cancelling the stream aborts the underlying LLM call', async () => {
		const { stream, calls } = fakeStream(['partial answer']);
		const rs = chatground(baseOpts({ streamLLM: stream }));
		const reader = rs.getReader();
		await reader.read();
		await reader.cancel();
		expect(calls[0].signal?.aborted).toBe(true);
	});
});

describe('chatground — error frames', () => {
	it('transport failure mid-stream emits an error frame and closes', async () => {
		const failing: StreamLLM = async function* () {
			yield 'All three Infineon';
			throw new TypeError('socket hangup');
		};
		const frames = await readFrames(chatground(baseOpts({ streamLLM: failing })));
		const types = frames.map((f) => f.type);
		expect(types[0]).toBe('delta');
		expect(types[types.length - 1]).toBe('error');
		expect(String(frames[frames.length - 1].message)).toContain('socket hangup');
	});

	it('no API key emits an error frame (defensive; routes envelope this pre-stream)', async () => {
		const { stream, calls } = fakeStream(['anything at all']);
		const frames = await readFrames(
			chatground(
				baseOpts({
					streamLLM: stream,
					provider: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: '' }
				})
			)
		);
		expect(frames).toHaveLength(1);
		expect(frames[0].type).toBe('error');
		expect(calls).toHaveLength(0); // never called the model
	});
});
