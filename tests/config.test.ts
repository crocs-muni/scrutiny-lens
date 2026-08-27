import { describe, it, expect, beforeEach } from 'vitest';
import { parseConfig } from '$lib/server/config';

describe('env config', () => {
	beforeEach(() => {
		delete process.env.API_KEY;
		delete process.env.BASE_URL;
		delete process.env.MODEL;
		delete process.env.PUBLIC_RELAY_URLS;
	});

	it('applies defaults when no env is provided', () => {
		const cfg = parseConfig({});
		expect(cfg.baseUrl).toBe('https://llm.ai.e-infra.cz/v1');
		expect(cfg.model).toBe('coder');
		expect(cfg.relayUrls).toEqual(['ws://localhost:8080/ws']);
		expect(cfg.apiKey).toBe('');
	});

	it('parses 1-4 comma-separated relay urls', () => {
		const cfg = parseConfig({
			PUBLIC_RELAY_URLS: 'ws://a/ws, wss://b/ws, ws://c/ws'
		});
		expect(cfg.relayUrls).toEqual(['ws://a/ws', 'wss://b/ws', 'ws://c/ws']);
	});

	it('accepts exactly 4 relay urls', () => {
		const urls = Array.from({ length: 4 }, (_, i) => `ws://r${i}/ws`).join(',');
		const cfg = parseConfig({ PUBLIC_RELAY_URLS: urls });
		expect(cfg.relayUrls).toHaveLength(4);
	});

	it('rejects more than 4 relay urls', () => {
		const urls = Array.from({ length: 5 }, (_, i) => `ws://r${i}/ws`).join(',');
		expect(() => parseConfig({ PUBLIC_RELAY_URLS: urls })).toThrow();
	});

	it('rejects an empty relay list', () => {
		expect(() => parseConfig({ PUBLIC_RELAY_URLS: '' })).toThrow();
	});

	it('rejects a non-ws relay scheme', () => {
		expect(() => parseConfig({ PUBLIC_RELAY_URLS: 'http://localhost:8080' })).toThrow();
	});

	it('carries the api key when provided', () => {
		const cfg = parseConfig({ API_KEY: 'sk-test' });
		expect(cfg.apiKey).toBe('sk-test');
	});

	it('applies provided base url and model', () => {
		const cfg = parseConfig({ BASE_URL: 'https://api.example.com/v1', MODEL: 'gpt-x' });
		expect(cfg.baseUrl).toBe('https://api.example.com/v1');
		expect(cfg.model).toBe('gpt-x');
	});
});
