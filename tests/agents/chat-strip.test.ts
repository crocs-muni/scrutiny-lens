import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { CallLLMArgs } from '$lib/ai/output';
import { chatground, type StreamLLM } from '$lib/ai/agents/chat';
import { scrubAnswer } from '$lib/chat/answer';

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

/* User ruling 2026-09-17: STRIP. What the PQC chat leaked on screen —
 * a balanced-but-invalid marker payload rendering as raw corrupt JSON —
 * must be impossible at the settle surface and at the scrub. */
describe('settle gate — malformed markers strip, never render', () => {
	it('balanced-but-invalid marker payload leaves no JSON trace in the final content', async () => {
		const ground = event('ev-007f', 'MultiApp 5.2 Premium PQC supports CRYSTALS-KYBER.');
		const corrupt = 'ML-KEM [2]{"eventId":"ev-007f","quote":"Kyber":{"KYBER":1,"CRYSTALS-KYBER":1}} is the KEM.';
		const { stream } = fakeStream([corrupt]);
		const frames = await readFrames(
			chatground({ question: 'q', history: [], groundingEvents: [ground], rootSummary: 'r', provider: PROVIDER, streamLLM: stream })
		);
		const final = frames[frames.length - 1];
		expect(final.type).toBe('final');
		const content = String(final.content);
		expect(content).not.toContain('{"eventId"');
		expect(content).not.toContain('KYBER":1');
		expect(content).toContain('ML-KEM');
		expect(final.citations ?? []).toEqual([]);
	});

	it('verified + corrupt markers in one answer: verified stays numbered, corrupt strips', async () => {
		const ground = event('ev-good', 'Infineon RSA library used in smartcards (ROCA).');
		const mixed =
			'ROCA affects cards [1]{"eventId":"ev-good","quote":"Infineon RSA library used in smartcards (ROCA)."} ' +
			'and something else [2]{"eventId":"ev-good","quote":"bad":{"oops":1}}.';
		const { stream } = fakeStream([mixed]);
		const frames = await readFrames(
			chatground({ question: 'q', history: [], groundingEvents: [ground], rootSummary: 'r', provider: PROVIDER, streamLLM: stream })
		);
		const final = frames[frames.length - 1];
		const content = String(final.content);
		expect(content).toBe('ROCA affects cards [1] and something else.');
		const cites = final.citations as { verified: boolean }[];
		expect(cites).toHaveLength(1);
	});

	it('scrub strips the leftover number of a marker whose verification failed downstream', () => {
		// End-to-end drift guard: resolveFinal kept a marker the verifier
		// later convicts → scrub removes both the number and the citation.
		const out = scrubAnswer('The scam [1] continues [2].', [
			{ n: 1, verified: true },
			{ n: 2, verified: false }
		]);
		expect(out.content).toBe('The scam [1] continues.');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
	});
});
