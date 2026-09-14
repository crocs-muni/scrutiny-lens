import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { CallLLMArgs } from '$lib/ai/output';
import type { StreamLLM } from '$lib/ai/agents/chat';
import { chat, resetChat, type SendContext } from '$lib/chat.svelte';
import { clearAllLocalData, getChatPins, initPersistence, listChatMessages, _closeForTests } from '$lib/db';

/* The chat store is where the trust rulings become behavior: settle-time
 * scrubbing (unverified markers never reach a transcript), record-shaped
 * persistence (question + answer land together; errors/aborts land never),
 * and per-conversation numbering that survives a hydrate (ADR 0002/0003). */

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

const EVENTS = [
	event('ev-prod', 'Infineon RSA library used in smartcards (ROCA).'),
	event('ev-vuln', 'ROCA: Return of Coppersmith Attack on RSA key generation.')
];

function fakeStream(chunks: string[]): StreamLLM {
	return async function* (_args: CallLLMArgs) {
		for (const c of chunks) yield c;
	};
}

function ctx(over: Partial<SendContext> = {}): SendContext {
	return {
		events: EVENTS,
		rootSummary: 'Infineon M7794 · ROCA exposure',
		provider: PROVIDER,
		...over
	};
}

const MARKER = (id: string, quote: string) => `[1]${JSON.stringify({ eventId: id, quote })}`;

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetChat();
	await chat.hydrate('s1');
});

afterEach(() => {
	resetChat();
	_closeForTests();
});

describe('chat store — settle', () => {
	it('persists question and answer together; unverified citations vanish from both', async () => {
		const good = MARKER('ev-prod', 'Infineon RSA library used in smartcards (ROCA).');
		const bad = MARKER('ev-vuln', 'a fabricated severity rating');
		await chat.send('which report proves keygen is affected?', ctx({
			streamLLM: fakeStream([`Affected ${good} and severe ${bad}.`])
		}));

		const assistant = chat.messages.at(-1);
		expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(assistant?.content).toBe('Affected [1] and severe.');
		expect(assistant?.citations).toHaveLength(1);
		expect(assistant?.claimsSummary).toEqual({ total: 2, verbatim: 1, partial: 0, extrapolatory: 1 });

		// The RECORD: both rows landed, scrubbed — history carries no trace
		// of the failed citation (ADR 0003).
		const rows = await listChatMessages('s1');
		expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(rows[1].content).toBe('Affected [1] and severe.');
		expect(rows[1].citations ?? []).toHaveLength(1);
	});

	it('conversation registry numbers stay stable across turns and survive hydrate', async () => {
		await chat.send('q1', ctx({ streamLLM: fakeStream([`A ${MARKER('ev-prod', 'Infineon RSA library used in smartcards (ROCA).')}`]) }));
		await chat.send('q2', ctx({
			streamLLM: fakeStream([
				`B ${MARKER('ev-vuln', 'ROCA: Return of Coppersmith Attack on RSA key generation.')} and [2]${JSON.stringify({ eventId: 'ev-prod', quote: 'Infineon RSA library used in smartcards (ROCA).' })}`
			])
		}));
		const second = chat.messages.at(-1);
		expect(second?.content).toBe('B [2] and [1]');

		// The pins record keeps numbering (and color pairing) reload-stable.
		expect((await getChatPins('s1'))?.pins).toEqual(['ev-prod', 'ev-vuln']);

		await chat.hydrate('s1'); // same-session guard
		resetChat();
		await chat.hydrate('s1');
		expect(chat.messages).toHaveLength(4);
		// The monotonic clock pins turn order across hydration: question,
		// answer, question, answer — never a transposed pair.
		expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect(chat.registry.eventIdFor(1)).toBe('ev-prod');
		expect(chat.registry.eventIdFor(2)).toBe('ev-vuln');
		// History maps through: answer 2 still resolves citation numbers.
		expect(chat.messages.at(-1)?.citations?.map((c) => [c.n, c.eventId])).toEqual([
			[2, 'ev-vuln'],
			[1, 'ev-prod']
		]);
	});

	it('a partial match earns its pill with ONLY the verified span rendered (spec §2 rule 3 + issue acceptance)', async () => {
		// The model's longer tail never renders: the record carries the
		// matched span and the UI displays span ?? quote — the pill's quote is
		// verbatim by construction, never the model's extrapolation.
		const partial = MARKER('ev-vuln', 'According to sources ROCA: Return of Coppersmith Attack');
		await chat.send('q', ctx({ streamLLM: fakeStream([`Confirmed ${partial}.`]) }));
		const assistant = chat.messages.at(-1);
		const cite = assistant?.citations?.[0];
		expect(cite?.n).toBe(1);
		expect(cite?.span).toBe('ROCA: Return of Coppersmith Attack');
		expect(cite?.quote).toBe('According to sources ROCA: Return of Coppersmith Attack'); // audit trail only
		const rows = await listChatMessages('s1');
		expect(rows.at(-1)?.citations?.[0]?.span).toBe('ROCA: Return of Coppersmith Attack');
	});

	it('ungrounded answers persist the honest availableContext record', async () => {
		await chat.send('what about quantum chips?', ctx({
			streamLLM: fakeStream(['UNGROUNDED {"availableContext":"only ROCA-era RSA findings"}'])
		}));
		const assistant = chat.messages.at(-1);
		expect(assistant?.kind).toBe('ungrounded');
		expect(assistant?.availableContext).toBe('only ROCA-era RSA findings');
		const rows = await listChatMessages('s1');
		expect(rows.at(-1)?.availableContext).toBe('only ROCA-era RSA findings');
	});
});

describe('chat store — honest failures', () => {
	it('an error frame surfaces a settled error bubble and persists NOTHING of the turn', async () => {
		await chat.send('q', ctx({
			streamLLM: async function* () {
				throw new Error('gateway: provider unreachable');
			}
		}));
		expect(chat.error?.message).toContain('provider unreachable');
		await expect(listChatMessages('s1')).resolves.toEqual([]);
	});

	it('provider failure mid-stream keeps the partial prose (ruling 6) but persists nothing', async () => {
		await chat.send('q', ctx({
			streamLLM: async function* () {
				yield 'The answer was forming [1]{"eventId":"e';
				throw new Error('HTTP 502');
			}
		}));
		// The stream's partial prose survives on screen, raw-marker tail
		// included — the UI suppresses markers when rendering it; the trust
		// gates (pill/underline) never touch unverified prose. Nothing persists.
		expect(chat.error?.partial).toBe('The answer was forming [1]{"eventId":"e');
		await expect(listChatMessages('s1')).resolves.toEqual([]);
	});

	it('abort persists nothing: no question, no partial answer', async () => {
		let release: (() => void) | undefined;
		const gated = new Promise<void>((res) => (release = res));
		const pending = chat.send('q', ctx({
			streamLLM: async function* () {
				yield 'partial prose ';
				await gated;
			}
		}));
		chat.abortInFlight();
		release?.();
		await pending;
		expect(chat.live).toBeNull();
		expect(chat.error).toBeNull();
		await expect(listChatMessages('s1')).resolves.toEqual([]);
	});
});

describe('chat store — session lifecycle', () => {
	it('hydrate loads another session without bleeding state across', async () => {
		// state = numbering + transcript; s2 starts empty and fresh.
		await chat.hydrate('s2');
		expect(chat.messages).toEqual([]);
		expect(chat.registry.size()).toBe(0);
	});
});
