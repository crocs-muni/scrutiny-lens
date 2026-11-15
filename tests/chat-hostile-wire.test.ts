// ADR 0003's unreachable edge, driven at the store: a chatground that emits
// an error frame and THEN a final frame must not get the turn persisted.
// The streamLLM seam cannot produce this wire (it yields raw model text and
// the pump wraps it), so this file mocks chatground itself.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { SendContext } from '$lib/chat.svelte';
import { clearAllLocalData, initPersistence, listChatMessages, _closeForTests } from '$lib/db';

vi.mock('$lib/ai/agents/chat', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/ai/agents/chat')>();
	return {
		...actual,
		chatground: () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					const enc = new TextEncoder();
					const sse = (payload: unknown) => enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
					controller.enqueue(sse({ type: 'error', message: 'hostile pump hiccup' }));
					controller.enqueue(
						sse({
							type: 'final',
							kind: 'answer',
							content: 'Affected [1]{"eventId":"ev-prod","quote":"x"}.',
							citations: []
						})
					);
					controller.close();
				}
			})
	};
});

const { chat } = await import('$lib/chat.svelte');

const EVENTS: NostrEvent[] = [
	{ id: 'ev-prod', sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content: 'Infineon RSA library used in smartcards (ROCA).' }
];

function ctx(over: Partial<SendContext> = {}): SendContext {
	return {
		events: EVENTS,
		rootSummary: 'Infineon M7794 · ROCA exposure',
		provider: { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' },
		...over
	};
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	chat.reset();
	await chat.hydrate('s1');
});

afterEach(async () => {
	chat.reset();
	await clearAllLocalData();
	await _closeForTests();
});

describe('chat store vs a hostile pump (ADR 0003)', () => {
	it('error then final: the error surfaces, the turn persists nothing', async () => {
		await chat.send('which report proves keygen is affected?', ctx({}));
		expect(chat.error?.message).toContain('hostile pump hiccup');
		expect(chat.messages).toEqual([]);
		await expect(listChatMessages('s1')).resolves.toEqual([]);
	});
});
