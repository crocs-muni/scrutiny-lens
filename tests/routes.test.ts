import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as queryPOST } from '../src/routes/api/ai/query/+server';
import { POST as cardsPOST } from '../src/routes/api/ai/cards/+server';
import { POST as nodesPOST } from '../src/routes/api/ai/nodes/+server';
import { POST as chatPOST } from '../src/routes/api/chat/+server';
import { POST as followupsPOST } from '../src/routes/api/ai/followups/+server';
import { STATIC_FOLLOWUPS } from '$lib/server/ai/agents/followups';
import { getProviderConfig } from '$lib/server/provider';
import { resetConfigCache } from '$lib/server/config';
import type { NostrEvent } from '$lib/server/fabric';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '$lib/server/db';
import { setCacheDb } from '$lib/server/ai/cache';

/* Spy on getProviderConfig while keeping the real implementation. */
vi.mock('$lib/server/provider', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/provider')>();
	return { ...mod, getProviderConfig: vi.fn(mod.getProviderConfig) };
});
const providerSpy = vi.mocked(getProviderConfig);

const BASE_HEADERS = { 'content-type': 'application/json' };

function makeEvent(url: string, body: unknown, headers: Record<string, string> = {}) {
	const request = new Request(url, {
		method: 'POST',
		headers: { ...BASE_HEADERS, ...headers },
		body: JSON.stringify(body)
	});
	return { request };
}
type QueryEvent = Parameters<typeof queryPOST>[0];
type CardsEvent = Parameters<typeof cardsPOST>[0];

function queryEvent(body: unknown, headers: Record<string, string> = {}): QueryEvent {
	// Minimal RequestEvent stub: the route handler reads only `event.request`.
	return makeEvent('https://t/api/ai/query', body, headers) as unknown as QueryEvent;
}

function cardsEvent(body: unknown): CardsEvent {
	return makeEvent('https://t/api/ai/cards', body) as unknown as CardsEvent;
}

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
	return {
		id: 'e'.repeat(64),
		sig: 'b'.repeat(128),
		pubkey: 'a'.repeat(64),
		created_at: 1700000000,
		kind: 1,
		tags: [],
		content: 'Infineon RSA library used in smartcards (ROCA).',
		...overrides
	};
}

function graph(i: number) {
	return {
		entityId: `ev-${i}`,
		event: event({ id: `ev-${i}` }),
		neighbors: [],
		stats: { boundMetadata: 1, attachments: 0, updates: 0 }
	};
}

const OVERRIDE = { baseUrl: 'https://byok.example.com/v1', model: 'byok-model', apiKey: 'sk-byok' };

beforeEach(() => {
	resetConfigCache();
	vi.stubEnv('API_KEY', '');
	vi.stubEnv('BASE_URL', 'https://llm.example.com/v1');
	vi.stubEnv('MODEL', 'env-model');
	vi.stubEnv('PUBLIC_RELAY_URLS', 'ws://localhost:8080/ws');
	providerSpy.mockClear();
	// Deterministic transport failure: any real chat call rejects instantly.
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	resetConfigCache();
	if (cacheDir !== undefined) {
		cacheDb?.close();
		setCacheDb(null);
		rmSync(cacheDir, { recursive: true, force: true });
		cacheDir = undefined;
		cacheDb = undefined;
	}
});

// vm_cache + dead_letter must not leak into the repo tree on 200-path tests.
let cacheDir: string | undefined;
let cacheDb: DatabaseSync | undefined;

function useTempCache(): void {
	cacheDir = mkdtempSync(join(tmpdir(), 'scrutiny-routes-'));
	cacheDb = openDb(join(cacheDir, 'scrutiny.db'));
	setCacheDb(cacheDb);
}

type NodesEvent = Parameters<typeof nodesPOST>[0];
type ChatEvent = Parameters<typeof chatPOST>[0];
type FollowupsEvent = Parameters<typeof followupsPOST>[0];

function nodesEvent(body: unknown): NodesEvent {
	return makeEvent('https://t/api/ai/nodes', body) as unknown as NodesEvent;
}

function chatEvent(body: unknown): ChatEvent {
	return makeEvent('https://t/api/chat', body) as unknown as ChatEvent;
}

function followupsEvent(body: unknown): FollowupsEvent {
	return makeEvent('https://t/api/ai/followups', body) as unknown as FollowupsEvent;
}

describe('POST /api/ai/query', () => {
	it('400 invalid_request on a bad body', async () => {
		const res = await queryPOST(queryEvent({}));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
		expect(Array.isArray(body.issues)).toBe(true);
		expect(body.issues.length).toBeGreaterThan(0);
	});

	it('400 on invalid JSON body', async () => {
		const request = new Request('https://t/api/ai/query', {
			method: 'POST',
			headers: BASE_HEADERS,
			body: 'not-json'
		});
		const res = await queryPOST({ request } as QueryEvent);
		expect(res.status).toBe(400);
	});

	it('503 no_key envelope when the agent has no key configured', async () => {
		const res = await queryPOST(
			queryEvent({ query: 'ROCA in Infineon' })
		);
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		const body = await res.json();
		expect(body.error).toBe('no_key');
		expect(body.retryable).toBe(true);
		expect(typeof body.message).toBe('string');
	});

	it('provider override from the body reaches getProviderConfig', async () => {
		const res = await queryPOST(
			queryEvent({ query: 'ROCA', provider: OVERRIDE })
		);
		expect(providerSpy).toHaveBeenCalledWith(OVERRIDE);
		// Override has a key, so the failure is transport-level, not no_key.
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error).toBe('unreachable');
	});

	it('provider override from the x-provider-override header reaches getProviderConfig', async () => {
		const res = await queryPOST(
			queryEvent({ query: 'ROCA' }, { 'x-provider-override': JSON.stringify(OVERRIDE) })
		);
		expect(providerSpy).toHaveBeenCalledWith(OVERRIDE);
		expect(res.status).toBe(503);
	});
});

describe('POST /api/ai/cards', () => {
	it('400 when graphs array is empty', async () => {
		const res = await cardsPOST(
			cardsEvent({ graphs: [], query: 'ROCA' })
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
	});

	it('400 when more than 24 graphs are posted', async () => {
		const graphs = Array.from({ length: 25 }, (_, i) => graph(i));
		const res = await cardsPOST(
			cardsEvent({ graphs, query: 'ROCA' })
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
		expect(Array.isArray(body.issues)).toBe(true);
	});

	it('503 no_key envelope without any provider key', async () => {
		const res = await cardsPOST(
			cardsEvent({ graphs: [graph(0)], query: 'ROCA' })
		);
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		const body = await res.json();
		expect(body.error).toBe('no_key');
	});

	it('provider override is forwarded to getProviderConfig', async () => {
		const res = await cardsPOST(
			cardsEvent({ graphs: [graph(0)], query: 'ROCA', provider: OVERRIDE })
		);
		expect(providerSpy).toHaveBeenCalledWith(OVERRIDE);
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error).toBe('unreachable');
	});
});

describe('POST /api/ai/nodes', () => {
	const PRODUCT = event({
		id: 				'a'.repeat(64),
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-product'],
			['t', 'scrutiny-v0.8.0']
		],
		content: 'Infineon M7794 A2 smartcard IC.'
	});
	const GRAPH_CONTEXT = { rootSummary: 'Infineon M7794 · ROCA exposure', query: 'ROCA' };

	it('400 when events array is empty', async () => {
		const res = await nodesPOST(nodesEvent({ events: [], graphContext: GRAPH_CONTEXT }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
	});

	it('503 no_key envelope without any provider key', async () => {
		const res = await nodesPOST(nodesEvent({ events: [PRODUCT], graphContext: GRAPH_CONTEXT }));
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		const body = await res.json();
		expect(body.error).toBe('no_key');
	});

	it('200 with a fetch-stubbed provider: one NodeVM per event', async () => {
		useTempCache();
		const completion = {
			id: 'chatcmpl-test',
			object: 'chat.completion',
			created: 0,
			model: OVERRIDE.model,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: JSON.stringify({ nodes: [{ title: 'M7794 A2', typeToken: 'smartcard' }] })
					},
					finish_reason: 'stop'
				}
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify(completion), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
		const res = await nodesPOST(
			nodesEvent({ events: [PRODUCT], graphContext: GRAPH_CONTEXT, provider: OVERRIDE })
		);
		expect(providerSpy).toHaveBeenCalledWith(OVERRIDE);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0].kind).toBe('product');
		expect(body.nodes[0].typeToken).toBe('smartcard');
		expect(body.nodes[0].title).toBe('M7794 A2');
	});
});

describe('POST /api/ai/followups', () => {
	const FOLLOWUP_BODY = {
		question: 'What is ROCA?',
		answer: 'Grounded answer.',
		rootSummary: 'Infineon M7794 · ROCA exposure'
	};

	it('400 on a malformed body', async () => {
		const res = await followupsPOST(followupsEvent({}));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
	});

	it('200 degrades to STATIC_FOLLOWUPS when no provider key is available', async () => {
		const res = await followupsPOST(followupsEvent(FOLLOWUP_BODY));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.followUps).toEqual(STATIC_FOLLOWUPS);
	});

	it('200 returns the LLM-suggested follow-ups', async () => {
		useTempCache();
		const suggestions = ['Which EAL certificates exist for it?', 'Show bound metadata items.'];
		const completion = {
			id: 'chatcmpl-test',
			object: 'chat.completion',
			created: 0,
			model: OVERRIDE.model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: JSON.stringify(suggestions) },
					finish_reason: 'stop'
				}
			],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify(completion), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
		const res = await followupsPOST(followupsEvent({ ...FOLLOWUP_BODY, provider: OVERRIDE }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.followUps).toEqual(suggestions);
	});
});

describe('POST /api/chat', () => {
	const CHAT_EVENT = event({
		id: 				'd'.repeat(64),
		content: 'Infineon RSA library used in smartcards (ROCA).'
	});

	it('400 on a malformed body', async () => {
		const res = await chatPOST(chatEvent({}));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_request');
	});

	it('503 no_key envelope without any provider key', async () => {
		const res = await chatPOST(
			chatEvent({
				question: 'Which vulnerability affects this chip?',
				rootSummary: 'Infineon M7794 · ROCA exposure',
				visibleEvents: [CHAT_EVENT]
			})
		);
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('30');
		const body = await res.json();
		expect(body.error).toBe('no_key');
	});
});
