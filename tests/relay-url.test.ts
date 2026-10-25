// Canonical relay URLs (issue #131, spec §8): one relay, one string —
// every boundary (settings relays, env defaults, transport maps, seen-on
// hints) routes through canonicalRelayUrl(s), so their forms collapse here.

import { describe, expect, it } from 'vitest';
import {
	canonicalRelayUrl,
	canonicalRelayUrls,
	type RelayUrlIssueReason
} from '../src/lib/net/relay-url';

describe('canonicalRelayUrl', () => {
	it.each([
		['WSS://Relay.Primal.NET/', 'wss://relay.primal.net'],
		['wss://relay.example:443/', 'wss://relay.example'],
		['ws://relay.example:80', 'ws://relay.example'],
		['wss://relay.example/newlay/', 'wss://relay.example/newlay']
	])('canonicalizes %s -> %s', (input, expected) => {
		const result = canonicalRelayUrl(input);
		expect(result).toEqual({ ok: true, url: expected });
	});

	it.each<[string, RelayUrlIssueReason]>([
		['wss://relay.example/x?y=1', 'query-or-fragment'],
		['wss://relay.example/x#z', 'query-or-fragment'],
		['wss://user:pw@relay.example', 'credentials'],
		['https://relay.example', 'bad-scheme'],
		['   ', 'empty'],
		['not a url', 'not-a-url']
	])('rejects %s as %s', (input, reason) => {
		expect(canonicalRelayUrl(input)).toEqual({ ok: false, issue: { input, reason } });
	});

	it('keeps non-default ports (dev runs ws://127.0.0.1:3334)', () => {
		expect(canonicalRelayUrl('ws://127.0.0.1:3334')).toEqual({ ok: true, url: 'ws://127.0.0.1:3334' });
	});
});

describe('canonicalRelayUrls', () => {
	it('dedupes on the canonical value, first wins, order preserved', () => {
		const { urls, issues } = canonicalRelayUrls([
			'wss://relay.a/',
			'wss://relay.b',
			'WSS://RELAY.A',
			'wss://relay.c:443',
			'wss://relay.b/'
		]);
		expect(urls).toEqual(['wss://relay.a', 'wss://relay.b', 'wss://relay.c']);
		expect(issues).toEqual([]);
	});

	it('collects an issue per rejected entry, carrying its input', () => {
		const { urls, issues } = canonicalRelayUrls([
			'wss://relay.example',
			'https://relay.example',
			'wss://user:pw@relay.example',
			'wss://relay.example/'
		]);
		expect(urls).toEqual(['wss://relay.example']);
		expect(issues).toEqual([
			{ input: 'https://relay.example', reason: 'bad-scheme' },
			{ input: 'wss://user:pw@relay.example', reason: 'credentials' }
		]);
	});

	it('never throws and returns empty results for an empty list', () => {
		expect(canonicalRelayUrls([])).toEqual({ urls: [], issues: [] });
	});
});
