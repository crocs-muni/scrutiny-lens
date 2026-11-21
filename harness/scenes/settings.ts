// Settings scene (spec §5): the dialog with the BYOK key restored from this
// tab's session and the endpoint's single-model list open in the combobox.

import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { HARNESS_MODEL } from '../ai.ts';

const chains = loadFixture('chains');

export function settingsScenes(): Scene[] {
	return [
		{
			id: 'settings-dialog',
			relays: [{ host: 'relay-a.test', events: chains }],
			apiKey: true,
			// The endpoint field shows the harness server's random port; mask it
			// so the dialog's text is launch-independent (the port is not UI).
			mask: [{ pattern: /:\d+\/v1$/, replacement: ':0/v1' }],
			async run({ page, url }) {
				await page.goto(`${url}/`);
				// The rail's Settings dock button (Ctrl+, does not reach the
				// shell handler under Playwright's trusted key events here).
				await page.getByRole('button', { name: /^Settings/ }).first().click();
				await page.getByRole('dialog', { name: 'Settings' }).waitFor();
				// GET /v1/models answered one model; open the list so the shot
				// shows the choice the auto-select made (spec §5).
				await page.getByRole('button', { name: 'Show models' }).click();
				await page.getByRole('option', { name: HARNESS_MODEL }).waitFor();
			},
			expect: ['Settings', 'AI provider', 'RELAYS', HARNESS_MODEL],
			// The open listbox overlaps the dialog panel, so axe cannot
			// determine the panel's background and reports every text node as
			// incomplete. Close it after the screenshot; the dialog itself is
			// what this scene audits.
			async a11yPrep({ page }) {
				await page.getByRole('button', { name: 'Show models' }).click();
				await page.getByRole('option', { name: HARNESS_MODEL }).waitFor({ state: 'hidden' });
			}
		}
	];
}
