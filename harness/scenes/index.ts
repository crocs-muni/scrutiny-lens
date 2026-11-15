import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { CHAINS_TAG } from '../seed/chains.ts';

/** Ask the app a question the way a person does: type it and press Enter. */
const ask: Scene['run'] = async ({ page, url }) => {
	await page.goto(`${url}/`);
	const question = page.getByLabel('Question');
	await question.fill(CHAINS_TAG);
	await question.press('Enter');
};

/** Built on demand so `harness seed` can run before any fixture file exists. */
export function buildScenes(): readonly Scene[] {
	const chains = loadFixture('chains');
	return [
		{
			id: 'results-chains',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run(ctx) {
				await ask(ctx);
				await ctx.page.getByText('Infineon M7794').first().waitFor({ timeout: 15_000 });
			},
			expect: ['Infineon M7794', 'NXP JCOP4', 'Atmel AT90SC25672RCT']
		}
	];
}
