// Live model list (issue #11, spec §5): the settings combobox is fed from
// the configured endpoint's /v1/models. Zod-gated like every AI surface;
// HTTP/network failures surface as kinds, never as thrown exceptions, and
// the key never leaks into error output (ADR-018).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModels } from '../src/lib/ai/models';

const KEY = 'sk-abcdef-1234567890';

function okResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchModels', () => {
	it('parses and sorts the OpenAI-style model list', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => okResponse({ data: [{ id: 'model-b' }, { id: 'model-a' }] }))
		);
		const result = await fetchModels('https://llm.example/v1', KEY);
		expect(result).toEqual({ ok: true, models: ['model-a', 'model-b'] });
	});

	it('hits <base>/models with the bearer key, tolerating a trailing slash', async () => {
		const spy = vi.fn(async () => okResponse({ data: [] }));
		vi.stubGlobal('fetch', spy);
		await fetchModels('https://llm.example/v1/', KEY);
		const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://llm.example/v1/models');
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
	});

	it('surfaces HTTP failures as a kind with the status', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => okResponse({}, 401)));
		expect(await fetchModels('https://llm.example/v1', KEY)).toEqual({
			ok: false,
			kind: 'http',
			status: 401
		});
	});

	it('rejects a shape that is not an OpenAI model list', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => okResponse({ data: [{ name: 'no-id' }] })));
		expect(await fetchModels('https://llm.example/v1', KEY)).toEqual({ ok: false, kind: 'invalid' });
	});

	it('surfaces a connection failure as a kind, never a throw', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		expect(await fetchModels('https://llm.example/v1', KEY)).toEqual({ ok: false, kind: 'network' });
	});

	it('never echoes the API key into an error result', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed');
			})
		);
		const result = await fetchModels('https://llm.example/v1', KEY);
		expect(JSON.stringify(result)).not.toContain(KEY);
	});
});
