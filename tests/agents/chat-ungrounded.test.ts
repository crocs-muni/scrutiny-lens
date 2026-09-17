import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { CallLLMArgs } from '$lib/ai/output';
import { chatground, type StreamLLM } from '$lib/ai/agents/chat';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

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

/* Live complaint 2026-09-17 (PQTunnel card chat): the UNGROUNDED lane's
 * availableContext rendered bracketed 64-hex event ids as fake citations
 * straight onto the screen. The frame strips them before persistence. */
describe('ungrounded frame — raw id brackets never reach the screen', () => {
	it('strips [64-hex] tokens from availableContext', async () => {
		const id1 = 'a1'.repeat(32);
		const id2 = 'b2'.repeat(32);
		const available = `The session events describe PQTunnel v1.1.5 [${id1}] and PQC analysis [${id2}].`;
		const { stream } = fakeStream([`UNGROUNDED {"availableContext":${JSON.stringify(available)}}`]);
		const frames = await readFrames(
			chatground({
				question: 'what can you tell me about this card?',
				history: [],
				groundingEvents: [event(id1, 'PQTunnel v1.1.5'), event(id2, 'PQC analysis')],
				rootSummary: 'PQTunnel v1.1.5',
				provider: PROVIDER,
				streamLLM: stream
			})
		);
		const final = frames[frames.length - 1];
		expect(final.kind).toBe('ungrounded');
		const ctx = String(final.availableContext);
		expect(ctx).not.toContain(id1);
		expect(ctx).not.toContain(id2);
		expect(ctx).not.toContain('[');
		expect(ctx).toContain('PQTunnel v1.1.5');
	});

	it('context made ONLY of id brackets falls back to the root summary, never an empty bubble', async () => {
		const id1 = 'cc'.repeat(32);
		const { stream } = fakeStream([`UNGROUNDED {"availableContext":"[${id1}]"}`]);
		const frames = await readFrames(
			chatground({
				question: 'q',
				history: [],
				groundingEvents: [event(id1, 'x')],
				rootSummary: 'Root subject',
				provider: PROVIDER,
				streamLLM: stream
			})
		);
		const final = frames[frames.length - 1];
		expect(final.availableContext).toBe('Root subject');
	});
});
