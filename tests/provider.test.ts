import { describe, it, expect, beforeEach } from 'vitest';
import { getProviderConfig } from '$lib/server/provider';
import { resetConfigCache } from '$lib/server/config';

describe('getProviderConfig', () => {
	beforeEach(() => {
		resetConfigCache();
		process.env.API_KEY = 'sk-env-test';
		process.env.BASE_URL = 'https://llm.ai.e-infra.cz/v1';
		process.env.MODEL = 'coder';
		process.env.PUBLIC_RELAY_URLS = 'ws://localhost:8080/ws';
	});

	it('falls back to env config when no override is given', () => {
		const r = getProviderConfig();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.config.name).toBe('env');
			expect(r.config.baseUrl).toBe('https://llm.ai.e-infra.cz/v1');
			expect(r.config.model).toBe('coder');
		}
	});

	it('rejects an override with a non-http baseUrl', () => {
		const r = getProviderConfig({ baseUrl: 'ftp://x', model: 'm', apiKey: 'k' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.kind).toBe('invalid_request');
	});

	it('rejects an override with an empty apiKey', () => {
		const r = getProviderConfig({ baseUrl: 'https://x/v1', model: 'm', apiKey: '' });
		expect(r.ok).toBe(false);
	});

	it('rejects an override with an empty model', () => {
		const r = getProviderConfig({ baseUrl: 'https://x/v1', model: '', apiKey: 'k' });
		expect(r.ok).toBe(false);
	});

	it('never surfaces the override apiKey value in the error output (ADR-018)', () => {
		const secret = 'sk-SECRET-DO-NOT-LEAK-12345';
		const r = getProviderConfig({ baseUrl: 'not-a-url', model: '', apiKey: secret });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(JSON.stringify(r)).not.toContain(secret);
		}
	});

	it('accepts a valid override and defaults its name', () => {
		const r = getProviderConfig({
			baseUrl: 'https://api.example.com/v1',
			model: 'gpt-x',
			apiKey: 'sk-valid'
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.config.name).toBe('override');
			expect(r.config.model).toBe('gpt-x');
			expect(r.config.baseUrl).toBe('https://api.example.com/v1');
		}
	});
});
