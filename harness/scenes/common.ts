// Shared scene helpers: every scene drives the app the way a person does
// (accessible names, text, keyboard) and waits on observable state instead
// of fixed delays.

import type { Locator, Page } from 'playwright';
import { HARNESS_MODEL } from '../ai.ts';
import type { Scene, SceneContext } from '../capture.ts';

/** The trace's done row prints the run's real elapsed time
 * (`TaskTrace.svelte`), which differs between launches of the same build —
 * the one clock-derived string on the results surface. Masked to a constant
 * before the shot; nothing else in the row is touched. */
export const MASK_ELAPSED = [{ pattern: / · \d+\.\ds\b/, replacement: ' · 0.0s' }];

/** Ask from the hero composer the way a person does. */
export async function ask(page: Page, url: string, question: string): Promise<void> {
	if (!page.url().startsWith(url)) await page.goto(`${url}/`);
	// Exact, role-scoped: 'Search' also prefixes the recents rail's
	// "Search sessions" field and the submit tooltip, and Playwright's label
	// match is a substring by default.
	const composer = page.getByRole('textbox', { name: 'Search', exact: true });
	await composer.fill(question);
	await composer.press('Enter');
}

/** Poll a harness-side predicate (relay/stub state) without touching the
 * page clock. */
export async function waitFor(
	check: () => boolean,
	what: string,
	timeoutMs = 15_000
): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Wait until the stub has answered everything it was asked: no request in
 * flight and no new request for `quietMs`. Prevents screenshots of a
 * half-trickled fill (the graph's node lane, the cards' fill lane). */
export async function waitAiIdle(ctx: SceneContext, quietMs = 400): Promise<void> {
	let calls = ctx.ai.count();
	let since = Date.now();
	const started = Date.now();
	for (;;) {
		if (ctx.ai.count() !== calls || ctx.ai.pending() > 0) {
			calls = ctx.ai.count();
			since = Date.now();
		} else if (Date.now() - since >= quietMs) {
			return;
		}
		if (Date.now() - started > 20_000) {
			throw new Error(`AI stub never went idle (${calls} calls, ${ctx.ai.pending()} pending)`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Set up the BYOK key/model through the real Settings dialog: a keyed app
 * with no model never fills (investigation.fillDesired), so scenes that
 * exercise the AI path open the dialog once, let the single-model auto-select
 * run, and close it. */
export async function enableAi(page: Page, url: string): Promise<void> {
	if (!page.url().startsWith(url)) await page.goto(`${url}/`);
	// The rail's visible Settings button, not Ctrl+,: in this build the
	// shortcut's keydown never reaches the shell handler (see report), while
	// the button path is the same shell.toggleSettings call.
	await page.getByRole('button', { name: /^Settings/ }).first().click();
	const dialog = page.getByRole('dialog', { name: 'Settings' });
	await dialog.waitFor();
	await page.getByRole('button', { name: 'Show models' }).click();
	// The option exists only after GET /v1/models resolved; the auto-select
	// runs in the same handler that fills the list.
	await page.getByRole('option', { name: HARNESS_MODEL }).waitFor();
	await page.keyboard.press('Escape'); // closes the combobox layer
	await page.getByRole('button', { name: 'Close settings' }).click();
	await dialog.waitFor({ state: 'detached' });
}

/** Click the result card whose text names the product. */
export function cardOf(page: Page, text: string): Locator {
	return page.locator('article[role="button"]', { hasText: text }).first();
}

/** Open a result card's dossier (the app lands on the session surface with
 * the drawer open) and pick a drawer section. */
export async function openDossier(page: Page, cardText: string, section: string): Promise<void> {
	await cardOf(page, cardText).click();
	const drawer = page.getByRole('region', { name: 'Detail drawer' });
	await drawer.getByRole('button', { name: new RegExp(`^${section}`) }).click();
}

/** The graph's own freeze disclosure (CanvasToolbar) plus a quiet window on
 * the camera/world and every node transform — the chip alone can flip before
 * the settle-correction glide has landed.
 *
 * Residual noise: d3-force advances on real rAF timestamps, so the final node
 * coordinates differ by subpixel fractions between launches. The freeze wait
 * removes visible motion; the remaining AA-level jitter (a few hundred pixels
 * on text edges) is the per-scene floor the determinism ledger records and
 * `compare` must clear. */
export async function waitGraphFrozen(page: Page): Promise<void> {
	await page.getByRole('toolbar', { name: 'Graph toolbar' }).getByText('frozen').waitFor();
	// Finite CSS animations (Svelte transitions, bloom flips) must be over;
	// infinite ones (the fill sweep) cannot finish and are excluded.
	await page.waitForFunction(() =>
		document.getAnimations().every((animation) => {
			const timing = animation.effect?.getTiming();
			return timing?.iterations === Infinity || animation.playState !== 'running';
		})
	);
	await page.waitForFunction(() => {
		const snapshot = (): string => {
			const world = document.querySelector<HTMLElement>('.world');
			const nodes = [...document.querySelectorAll<HTMLElement>('.scrutiny-node')];
			return world === null
				? ''
				: [world.style.transform, ...nodes.map((node) => node.style.transform)].join('|');
		};
		return new Promise<boolean>((resolve) => {
			// A 500 ms quiet window: the sim's freeze is a hard stop, but the
			// settle-correction glide can start in the same frame the chip
			// flips — two samples 200 ms apart missed it under load.
			let last = snapshot();
			let quiet = 0;
			const started = performance.now();
			const tick = (): void => {
				const next = snapshot();
				if (next === '') return resolve(false);
				quiet = next === last ? quiet + 16 : 0;
				last = next;
				if (quiet >= 500) return resolve(true);
				if (performance.now() - started > 15_000) return resolve(false);
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
	});
}

/** Assert a string is NOT on screen (settled outcomes the app must strip,
 * e.g. a citation whose quote failed verification). Throws, so the scene's
 * `error` fact carries the failure. */
export async function mustNotBeVisible(page: Page, text: string): Promise<void> {
	if ((await page.getByText(text, { exact: false }).count()) > 0) {
		const visible = await page.getByText(text, { exact: false }).first().isVisible();
		if (visible) throw new Error(`unexpected text on screen: ${text}`);
	}
}

/** Remove the graph's decorative overlap before axe. The transparent card
 * button, ring plates and edge SVG sit over the node text; axe reports the
 * card text as an undetermined background instead of a contrast verdict.
 * `keepText` keeps the one node whose card is being audited (graph scene);
 * without it the graph is hidden and the drawer/chat surface is audited. */
export async function stripGraphForA11y(page: Page, keepText?: string): Promise<void> {
	await page.evaluate((keep) => {
		document.querySelectorAll('.node-ring, svg.edges, .node-hit').forEach((el) => el.remove());
		const nodes = [...document.querySelectorAll<HTMLElement>('.scrutiny-node')];
		if (keep === null) {
			for (const el of nodes) el.remove();
			return;
		}
		const subject = nodes.find((el) => el.textContent?.includes(keep));
		for (const el of nodes) if (el !== subject) el.remove();
		// A metadata card carries a diagonal hairline gradient; axe cannot
		// determine text contrast over it. The text sits on the surface fill,
		// so flatten only the card fill for the audit.
		for (const card of subject?.querySelectorAll<HTMLElement>('.graph-node > div') ?? []) {
			card.style.background = 'var(--surface)';
		}
	}, keepText ?? null);
}

/** The five dossier/chat scenes that audit their own surface, not the graph. */
export const stripGraph: NonNullable<Scene['a11yPrep']> = ({ page }) => stripGraphForA11y(page);
