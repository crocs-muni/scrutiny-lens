// Graph canvas scene (#29b → #95): open a result, let the map freeze on its
// own, and collapse the drawer so the canvas owns the frame.

import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import { ask, cardOf, stripGraphForA11y, waitGraphFrozen } from './common.ts';

const chains = loadFixture('chains');

export function graphScenes(): Scene[] {
	return [
		{
			id: 'graph-canvas',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await cardOf(page, 'Infineon M7794 A12').click();
				// The card opens the session with the drawer; collapse it so the
				// shot shows the map, not the dossier.
				await page.keyboard.press('Control+;');
				await page.locator('[data-drawer-collapsed="true"]').waitFor();
				await waitGraphFrozen(page);
			},
			expect: ['frozen', 'cc:HARNESS-CHAINS'],
			// The ring plates are decorative and overlap the card text in axe's
			// view; remove them after the screenshot so contrast reads the card
			// surface, not the halo.
			async a11yPrep({ page }) {
				await stripGraphForA11y(page, 'cc:HARNESS-CHAINS');
			}
		}
	];
}
