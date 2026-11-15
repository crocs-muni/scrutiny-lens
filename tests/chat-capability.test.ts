// Capability lane (issue #133, spec §2 rules 2 and 6): a meta question about
// the session is answered from computed counts, with no model call — including
// when no key is configured, which is exactly when a first-time analyst asks
// it. The chat agent's grounded exits cannot express "what is in here": a
// quote needs an event, and the refusal exit lets the model ruminate.

import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import { chatground, type StreamLLM } from '$lib/ai/agents/chat';
import { capabilityAnswer, isCapabilityQuestion, sessionFacts } from '$lib/chat/capability';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

function event(id: string, tags: string[][], content = ''): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags, content };
}

const PRODUCT = event('ev-prod', [['t', 'scrutiny-product']], 'Infineon SLE78 security controller');
const METADATA = [
	event('ev-test', [['t', 'scrutiny-metadata']], 'CC EAL6+ test report'),
	event('ev-advisory', [['t', 'scrutiny-metadata']], 'ROCA advisory')
];
const EVENTS = [PRODUCT, ...METADATA];

/** A stream that must never be called: records instead of yielding. */
function forbiddenStream(): { stream: StreamLLM; calls: () => number } {
	let calls = 0;
	const stream: StreamLLM = async function* () {
		calls += 1;
		yield 'should never run';
	};
	return { stream, calls: () => calls };
}

async function framesOf(
	question: string,
	events: NostrEvent[],
	opts: { stream?: StreamLLM; provider?: typeof PROVIDER } = {}
): Promise<Array<Record<string, unknown>>> {
	const reader = chatground({
		question,
		history: [],
		groundingEvents: events,
		rootSummary: 'Infineon SLE78',
		provider: opts.provider,
		...(opts.stream ? { streamLLM: opts.stream } : {})
	}).getReader();
	const decoder = new TextDecoder();
	let text = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	const out: Array<Record<string, unknown>> = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) continue;
		out.push(JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>);
	}
	return out;
}

describe('capability question classifier', () => {
	it.each([
		'what does this session contain?',
		'what can you do?',
		'what is in this session',
		'who are you',
		'what can I ask?',
		'What data is available here?',
		'help'
	])('owns the meta question: %s', (question) => {
		expect(isCapabilityQuestion(question)).toBe(true);
	});

	it.each([
		'which cards are affected by ROCA?',
		'what does this card say about certification?',
		'what can you tell me about CVE-2017-15361?',
		'is the SLE78 still certified?',
		'show me the patch history'
	])('leaves the grounded question to the model: %s', (question) => {
		expect(isCapabilityQuestion(question)).toBe(false);
	});
});

describe('capability answer', () => {
	it('counts the admitted set by root-product i-tag', () => {
		expect(sessionFacts(EVENTS)).toEqual({ total: 3, products: 1, metadata: 2 });
	});

	it('states the counts and the sourcing rule', () => {
		expect(capabilityAnswer('what does this session contain?', EVENTS)).toBe(
			'This chat can cite 3 admitted events: 1 product and 2 metadata records. ' +
				'I answer only from those events and quote the event behind every claim. ' +
				'Ask about a product, its tests, its advisories, or its patch history.'
		);
	});

	it('an empty session says so instead of reporting zero counts as a verdict', () => {
		const answer = capabilityAnswer('what can you do?', []);
		expect(answer).toContain('no admitted events to cite yet');
		expect(answer).not.toContain('0 products');
	});

	it('returns null for a grounded question', () => {
		expect(capabilityAnswer('which cards are affected by ROCA?', EVENTS)).toBeNull();
	});
});

describe('chat turn — capability questions settle without a model', () => {
	it('answers from computed facts and never calls the stream, even with no key', async () => {
		const fake = forbiddenStream();
		const frames = await framesOf('what does this session contain?', EVENTS, {
			stream: fake.stream
			// no provider: the zero-key session must still answer
		});
		expect(fake.calls()).toBe(0);
		const final = frames.find((f) => f.type === 'final');
		expect(final?.kind).toBeUndefined();
		expect(String(final?.content)).toContain('3 admitted events');
		expect(final?.citations).toEqual([]);
	});

	it('leaves a grounded question on the model path', async () => {
		let called = 0;
		const stream: StreamLLM = async function* () {
			called += 1;
			yield 'The SLE78 is certified.';
		};
		await framesOf('is the SLE78 still certified?', EVENTS, {
			stream,
			provider: PROVIDER
		});
		expect(called).toBe(1);
	});
});
