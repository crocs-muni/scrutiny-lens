// Results-surface scenes (spec §4 edge states, spec §3 cards): the plain
// result set, the AI-filled set, and the lanes that prove fallback + banner
// behaviour. Fixtures are the chains set; hypotheses are never invented.

import type { Page } from 'playwright';
import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { JUNK, okFill, okFillTruncated, holdFill } from '../ai.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import { ask, cardOf, enableAi, MASK_ELAPSED, waitFor } from './common.ts';

const chains = loadFixture('chains');

/** The fill lane's completion announcement (the results surface's polite
 * region) — proof the cards reached their interpreted face. */
async function waitAllFilled(page: Page, total: number): Promise<void> {
	await page.getByText(`All ${total} cards filled`).waitFor({ state: 'attached' });
}

export function resultsScenes(): Scene[] {
	return [
		{
			// The P0 scene, kept as-is: relay-served cards, no AI key.
			id: 'results-chains',
			relays: [{ host: 'relay-a.test', events: chains }],
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await cardOf(page, 'Infineon M7794').waitFor();
			},
			expect: ['Infineon M7794', 'NXP JCOP4', 'Atmel AT90SC25672RCT']
		},
		{
			// AI key + ok lane: every card reaches its interpreted face.
			id: 'results-filled',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: { lanes: { fill: [okFill] } },
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await waitAllFilled(page, 4);
			},
			expect: [
				'Infineon M7794 A12 smartcard — RSA keygen via vulnerable library.',
				'NXP JCOP4 SmartMX3 — JavaCard platform.'
			]
		},
		{
			// 429-then-ok: the gateway retries transparently; the cards still
			// fill and no banner survives.
			id: 'results-fill-429',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: {
				lanes: {
					fill: [{ kind: 'status', status: 429, retryAfterSec: 1, message: 'slow down' }, okFill]
				}
			},
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await waitAllFilled(page, 4);
			},
			expect: ['Infineon M7794 A12 smartcard — RSA keygen via vulnerable library.']
		},
		{
			// Truncated lane: the head of the batch is salvaged per record, the
			// rest stays raw, and the banner states the numeric truth.
			id: 'results-fill-truncated',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: { lanes: { fill: [okFillTruncated] } },
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await page.getByText(/Slow — \d+ of \d+ cards filled/).first().waitFor();
			},
			expect: ['Slow — 2 of 4 cards filled · the rest show the raw events']
		},
		{
			// Junk lane: the model answered, the output did not conform, and the
			// banner names that (never "unreachable", spec §2 never-lie).
			id: 'results-fill-junk',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: { lanes: { fill: [JUNK] } },
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await page.getByText("Output didn't conform", { exact: false }).first().waitFor();
			},
			expect: ["Output didn't conform", 'cards show the raw events']
		},
		{
			// AI down: the endpoint answers 5xx until the gateway's retries are
			// exhausted; every card falls back to its raw face + the banner.
			id: 'results-ai-down',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: {
				lanes: { fill: [{ kind: 'status', status: 500, message: 'harness: endpoint down' }] }
			},
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await page.getByText('Endpoint unreachable', { exact: false }).first().waitFor();
			},
			expect: ['Endpoint unreachable', 'cards show the raw events', 'Infineon M7794']
		},
		{
			// Zero results: relays answered EOSE with nothing. The empty state
			// is a settled fact, never a guess (spec §4).
			id: 'results-empty',
			relays: [{ host: 'relay-a.test', events: [] }],
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await page.getByText('Nothing matched on your relays').waitFor();
			},
			expect: ['Nothing matched on your relays', 'Searched 1 relays']
		},
		{
			// Relay lacks NIP-50: the free-text search degrades to a tag scan and
			// the notice names the relay (never "no matches", spec §4).
			id: 'relay-no-nip50',
			relays: [{ host: 'relay-a.test', events: chains, chaos: { lacksNip50: true } }],
			apiKey: true,
			ai: {
				lanes: {
					translate: [{ kind: 'ok', content: 'kind: text\nvalue: m7794' }],
					fill: [okFill]
				}
			},
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await enableAi(page, url);
				await ask(page, url, 'M7794');
				await page.getByText('lacks search support', { exact: false }).waitFor();
				await cardOf(page, 'Infineon M7794').waitFor();
			},
			expect: [
				'relay ws://relay-a.test lacks search support · falling back to a tag scan',
				'Infineon M7794'
			]
		},
		{
			// Mid-fill on purpose: the stub holds the fill response, so the
			// pending sweep and the dashed rule-5 face are the captured state.
			id: 'results-fill-inflight',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: { lanes: { fill: [holdFill] } },
			mask: MASK_ELAPSED,
			async run({ page, url, ai }) {
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await cardOf(page, 'Infineon M7794').waitFor();
				await waitFor(() => ai.pending() > 0, 'a held fill request');
				await page.locator('article[aria-busy="true"]').first().waitFor();
				// The sweep is an infinite animation; a still cannot show motion
				// and its captured phase differs per launch. Freeze it to the
				// gradient's initial position (the pending state still reads via
				// aria-busy + the dashed face + the neutral wash).
				await page.addStyleTag({ content: '.fill-sweep { animation: none !important; }' });
			},
			expect: ['Infineon M7794'],
			// The held fill's draft overlay is an aria-hidden, transient
			// pre-gate layer over the card; remove it for the audit so axe
			// reads the card underneath. The screenshot still shows the
			// mid-fill state.
			async a11yPrep({ page }) {
				await page.evaluate(() => {
					document
						.querySelectorAll('[aria-busy="true"] [aria-hidden="true"]')
						.forEach((el) => el.remove());
				});
			}
		}
	];
}
