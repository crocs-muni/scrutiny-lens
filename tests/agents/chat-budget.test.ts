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

function ground(question: string, events: NostrEvent[], stream: StreamLLM): ReadableStream<Uint8Array> {
	return chatground({
		question,
		history: [],
		groundingEvents: events,
		rootSummary: 'root',
		provider: PROVIDER,
		streamLLM: stream
	});
}

function promptOf(calls: CallLLMArgs[]): string {
	const last = calls[0].messages[calls[0].messages.length - 1] as { content: string };
	return last.content;
}

/* Grounding transport budget (2026-09-17): a full admitted cohort serialized
 * into one prompt exceeded the provider's prompt-eval window and every chat
 * answer died on the gateway's 30s first-byte limit. The trim is transport-
 * bounded, matched-first, and disclosed in the prompt itself. */
describe('chatground — grounding transport budget', () => {
	it('question-matched events enter the prompt before unmatched ones', async () => {
		const many = Array.from({ length: 60 }, (_, i) => event(`ev-${i}`, `filler content ${i}`));
		many.unshift(event('ev-hit', 'the word cuprates appears nowhere else in this session'));
		const { stream, calls } = fakeStream(['sure']);
		await readFrames(ground('find cuprates', many, stream));
		const prompt = promptOf(calls);
		expect(prompt.indexOf('ev-hit')).toBeLessThan(prompt.indexOf('ev-0'));
	});

	it('caps the grounding set at 40 events and discloses the scope in-prompt', async () => {
		const many = Array.from({ length: 60 }, (_, i) => event(`ev-${i}`, `filler content ${i}`));
		const { stream, calls } = fakeStream(['sure']);
		await readFrames(ground('anything', many, stream));
		const prompt = promptOf(calls);
		expect(prompt).toContain('Grounding scope: 40 of 60');
		// The wire-form JSON actually ends the 40-event block, never the 60th.
		expect(prompt).not.toContain('ev-59');
	});

	it('truncates oversize event content with the marker (single >budget event stays in scope)', async () => {
		const big = event('ev-big', 'x'.repeat(200_000));
		const { stream, calls } = fakeStream(['sure']);
		await readFrames(ground('ev-big presence', [big], stream));
		const prompt = promptOf(calls);
		expect(prompt).toContain('ev-big');
		expect(prompt).toContain('…[TRUNCATED]');
		expect(prompt.length).toBeLessThan(10_000);
	});

	it('small sessions ship with no scope line (the full citable set stays whole)', async () => {
		const small = [event('ev-a', 'a tiny event'), event('ev-b', 'another tiny event')];
		const { stream, calls } = fakeStream(['sure']);
		await readFrames(ground('hello', small, stream));
		const prompt = promptOf(calls);
		expect(prompt).not.toContain('Grounding scope:');
		expect(prompt).toContain('ev-a');
		expect(prompt).toContain('ev-b');
	});
});
