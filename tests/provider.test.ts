import { describe, it, expect } from 'vitest';
import { getProviderConfig } from '$lib/ai/provider';

describe('getProviderConfig', () => {
	it('reports no_key when no override is given', () => {
		const r = getProviderConfig();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.kind).toBe('no_key');
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
