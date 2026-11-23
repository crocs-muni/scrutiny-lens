// Session-surface scenes (issue #219): the page that carries graph + drawer +
// chat. The share route is the deterministic way in without a search run.
// One scene proves the trusted path (fixture key added through the real
// editor); one proves the honest untrusted empty state — the surface that
// dde25bc left blank.

import type { NostrEvent } from 'nostr-tools/core';
import { encodeShareNevent } from '../../src/lib/share/deep-link.ts';
import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import { trustFixturePublisher, waitGraphFrozen } from './common.ts';

const chains = loadFixture('chains');
const root = chains.find((event) =>
	event.tags.some(([key, value]) => key === 't' && value === 'scrutiny-product')
);
if (root === undefined) throw new Error('chains fixture has no product root');
const HINT = 'ws://relay-a.test';
const shareUrl = `/event/${encodeShareNevent(root, [HINT])}`;

export function sessionScenes(): Scene[] {
	return [
		{
			id: 'session-shared-trusted',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await trustFixturePublisher(page, url, { persist: true });
				await page.goto(`${url}${shareUrl}`);
				await page.locator('.stage').waitFor();
				await page.locator('.scrutiny-node').first().waitFor();
				await waitGraphFrozen(page);
			},
			expect: [CHAINS_TAG, 'Shared product']
		},
		{
			id: 'session-shared-untrusted',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await page.goto(`${url}${shareUrl}`);
				await page.locator('[data-session-trusted-empty]').waitFor();
			},
			expect: [
				'No records from your trusted publishers are in this session.',
				'outside the trusted view'
			]
		}
	];
}
