// Hero edge state (spec §4 "No AI key set"): the search surface is the first
// thing a new reader sees, and the no-key banner is the only warning there.
// The results-side no-key banner is covered by results-chains.

import type { Scene } from '../capture.ts';

export function heroScenes(): Scene[] {
	return [
		{
			id: 'hero-no-key',
			relays: [{ host: 'relay-a.test', events: [] }],
			async run({ page, url }) {
				await page.goto(`${url}/`);
				await page.getByText('No API key yet', { exact: false }).waitFor();
			},
			expect: ['No API key yet', 'Set one in Settings']
		}
	];
}
