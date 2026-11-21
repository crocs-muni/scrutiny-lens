// Chat scene (spec §2 rule 3, ADR 0003): a grounded answer whose first
// marker quotes fixture content verbatim, plus one claim whose quote does not
// exist — the app must strip it and say how many claims it dropped.
//
// NOT INCLUDED: the §4 "chat asked what the session contains" keyless row.
// The backend answers it before the provider check (agents/chat.ts's
// capabilityAnswer), but ChatColumn disables the composer while
// settings.apiKey is empty, so the UI path is unreachable. That is an
// implementation gap, not a scene.

import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { okFill, okNodes } from '../ai.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import {
	ask,
	cardOf,
	enableAi,
	MASK_ELAPSED,
	mustNotBeVisible,
	stripGraphForA11y,
	waitAiIdle,
	waitGraphFrozen
} from './common.ts';

const chains = loadFixture('chains');
const productA = chains.find((event) => event.content.startsWith('Infineon M7794 A12 smartcard'));
const target = chains.find((event) => event.content.startsWith('Security Target'));
if (productA === undefined || target === undefined) {
	throw new Error('chains fixture no longer carries product A and its Security Target record');
}

/** Two claims: [1] quotes product A verbatim; [2] cites the Security Target
 * with a sentence it does not contain (the quote gate must drop it). */
const ANSWER = [
	"The M7794's RSA key generation runs in a certified third-party library",
	`[1]{"eventId":"${productA.id}","quote":"RSA keygen via vulnerable library"}.`,
	'Its Common Criteria evaluation was raised to EAL4+ in 2019',
	`[2]{"eventId":"${target.id}","quote":"EAL4+ certification issued in 2019"}.`
].join(' ');

export function chatScenes(): Scene[] {
	return [
		{
			id: 'chat-citations',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			ai: {
				lanes: {
					fill: [okFill],
					nodes: [okNodes],
					chat: [{ kind: 'ok', content: ANSWER }]
				}
			},
			mask: MASK_ELAPSED,
			async run(ctx) {
				const { page, url } = ctx;
				await enableAi(page, url);
				await ask(page, url, CHAINS_TAG);
				await cardOf(page, 'Infineon M7794 A12').waitFor();
				await waitAiIdle(ctx);
				await cardOf(page, 'Infineon M7794 A12').click();
				const composer = page.getByLabel('Chat question');
				await composer.fill('How was the M7794 key generation affected?');
				await composer.press('Enter');
				await page.getByText('1 claim dropped', { exact: false }).waitFor();
				await mustNotBeVisible(page, '[2]');
				await waitAiIdle(ctx);
				await waitGraphFrozen(page);
			},
			expect: [
				'1 source',
				'1 claim dropped — the quote was not found in the cited record',
				'RSA key generation runs in a certified third-party library'
			],
			a11yPrep: ({ page }) => stripGraphForA11y(page)
		}
	];
}
