// Config surface (issue #11, spec §5/§8): env-derived defaults for the AI
// endpoint and the relay pool, plus the 1–4 relay bound the editor enforces.

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_ENDPOINT,
	DEFAULT_RELAYS,
	RELAY_MAX,
	RELAY_MIN,
	isValidRelayUrl,
	parseRelayUrls
} from '../src/lib/config';

describe('relay pool bounds (spec §8: 1–4 entries, owner ruling 2026-09-03)', () => {
	it('fixes the pool at 1–4 entries', () => {
		expect(RELAY_MIN).toBe(1);
		expect(RELAY_MAX).toBe(4);
	});
});

describe('parseRelayUrls', () => {
	it('splits a comma list, trims, drops empties', () => {
		expect(parseRelayUrls('wss://a, wss://b ,,c')).toEqual(['wss://a', 'wss://b', 'c']);
	});

	it('deduplicates while keeping first-seen order', () => {
		expect(parseRelayUrls('wss://a,wss://b,wss://a')).toEqual(['wss://a', 'wss://b']);
	});

	it('returns an empty list for unset config', () => {
		expect(parseRelayUrls('')).toEqual([]);
		expect(parseRelayUrls(' , ,')).toEqual([]);
	});
});

describe('isValidRelayUrl', () => {
	it('accepts ws and wss URLs', () => {
		expect(isValidRelayUrl('wss://relay.example.com')).toBe(true);
		expect(isValidRelayUrl('ws://localhost:8080/ws')).toBe(true);
	});

	it('rejects other schemes and malformed input', () => {
		expect(isValidRelayUrl('https://relay.example.com')).toBe(false);
		expect(isValidRelayUrl('relay.example.com')).toBe(false);
		expect(isValidRelayUrl('')).toBe(false);
	});
});

describe('env defaults', () => {
	it('ships the spec §5 endpoint when no env override exists', () => {
		// The test environment sets no PUBLIC_LLM_ENDPOINT.
		expect(DEFAULT_ENDPOINT).toBe('https://llm.ai.e-infra.cz/v1');
	});

	it('DEFAULT_RELAYS carries only valid relay URLs (env entries are filtered)', () => {
		for (const url of DEFAULT_RELAYS) expect(isValidRelayUrl(url)).toBe(true);
	});
});
