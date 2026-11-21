// Relay-edge scenes (spec §4): all relays dead, some relays dead, and a dead
// leg in the settle/dossier context fetch (a banner, never the error screen).
//
// NOT INCLUDED: the "N invalid skipped" scene. The relay-level bad-id knob
// works, but nostr-tools' pool verifies incoming events before the app's
// admission gate sees them, so a corrupted id never reaches the pipeline
// notice — and the owner ruling removed the footer from the results surface.
// Reported as a spec/architecture gap instead of shipping a red scene.

import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import { ask, cardOf, mustNotBeVisible, MASK_ELAPSED } from './common.ts';

const chains = loadFixture('chains');

export function chaosScenes(): Scene[] {
	return [
		{
			// Every relay refuses: the error screen, never "no matches".
			id: 'relays-all-dead',
			relays: [{ host: 'relay-dead.test', events: [], refuse: true }],
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await page.getByRole('heading', { name: 'No relay answered' }).waitFor();
			},
			expect: ['No relay answered', 'relay-dead.test', 'refused']
		},
		{
			// One leg refused: results from the rest + the corner notice.
			id: 'relays-some-dead',
			relays: [
				{ host: 'relay-a.test', events: chains },
				{ host: 'relay-dead.test', events: [], refuse: true }
			],
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await page.getByText('showing results from the rest').waitFor();
			},
			expect: [
				'relay ws://relay-dead.test refused — showing results from the rest',
				'Infineon M7794'
			]
		},
		{
			// The search is answered by relay-a, but the settle traversal asks
			// the same pool, so its refused leg degrades the CONTEXT only.
			// Spec §4: a context-fetch failure is a banner about incomplete
			// Files counts / retraction pills — never the all-relays-dead
			// error screen, which would falsely claim nothing was fetched.
			id: 'traversal-context-dead',
			relays: [
				{ host: 'relay-a.test', events: chains },
				{ host: 'relay-dead.test', events: [], refuse: true }
			],
			mask: MASK_ELAPSED,
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await page
					.getByText('context fetch skipped 1 of 2 relays', { exact: false })
					.waitFor();
				await cardOf(page, 'Infineon M7794').waitFor();
				// The §4 distinction this scene exists for: same dead relay,
				// banner instead of the error screen.
				await mustNotBeVisible(page, 'No relay answered');
			},
			expect: [
				'context fetch skipped 1 of 2 relays — Files counts and retraction pills may be incomplete',
				'Infineon M7794'
			]
		}
	];
}
