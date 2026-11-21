// Capture engine: puts the app into a scene's state and writes a screenshot
// plus a JSON of facts. Everything nondeterministic is pinned here:
//
// - network: relays are FakeRelay instances behind Playwright's
//   routeWebSocket, the NIP-11 probe is fulfilled by route(), so no real
//   socket is opened;
// - time: the page's Date is fixed (timers and rAF stay real, so the graph
//   settles on its own);
// - rendering: bundled Chromium, DSF 1, no LCD text, fixed locale, timezone
//   and colour scheme, animations disabled and caret hidden in the shot.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { compactViolations } from './a11y.ts';
import { createAiStub, type AiControl, type AiScript } from './ai.ts';
import { FakeRelay, type RelayChaos } from './relay.ts';
import { serveApp, type AiHandler } from './serve.ts';
import { PAGE_NOW_MS } from './time.ts';
import type { NostrEvent } from 'nostr-tools/core';

export type Theme = 'light' | 'dark';

export interface RelaySpec {
	/** Full hostname under .test; the app is configured with ws://<host>. */
	host: string;
	events: readonly NostrEvent[];
	chaos?: RelayChaos;
	/** Close the mocked socket immediately: the app's connect fails, the
	 * transport reports `refused` (spec §4 "all/some relays dead"). */
	refuse?: boolean;
}

/** Narrow, documented text substitution applied to the DOM before the shot:
 * for text the app renders from a real clock (e.g. the trace's elapsed
 * seconds), which would otherwise differ on every launch. */
export interface TextMask {
	pattern: RegExp;
	replacement: string;
}

export interface SceneContext {
	page: Page;
	url: string;
	relays: Map<string, FakeRelay>;
	/** The scene's AI stub (inert when the scene never calls the endpoint). */
	ai: AiControl;
}

export interface Scene {
	id: string;
	/** Relay pool for this scene, in the order the app is configured with. */
	relays: readonly RelaySpec[];
	themes?: readonly Theme[];
	viewport?: { width: number; height: number };
	/** Inject a fake API key so the AI path is exercised. */
	apiKey?: boolean;
	/** Per-scene AI script (default: the stub's content builders). */
	ai?: AiScript;
	/** Text the app renders from a live clock; masked before the shot. */
	mask?: readonly TextMask[];
	/** Page errors the scene expects (a documented app bug it must survive);
	 * kept in `knownPageErrors` facts, excluded from the pageerror gate. */
	allowPageErrors?: readonly RegExp[];
	/** Extra PUBLIC_* values for this scene. */
	env?: Record<string, string>;
	/** Drive the app to the state to capture. */
	run(ctx: SceneContext): Promise<void>;
	/** Text that must be visible once `run` finishes (a relay that returns
	 * nothing must not screenshot green). */
	expect: readonly string[];
	/** Runs after the screenshot and before axe (a11y captures only). Use it
	 * to remove an overlay that would make axe's contrast checks incomplete;
	 * the screenshot still shows the overlay. */
	a11yPrep?: (ctx: SceneContext) => Promise<void>;
}

/** One axe violation node, reduced to what a scoreboard can read: where, the
 * offending HTML, and why it failed. */
export interface A11yNode {
	/** Frame/shadow selectors; shadow parts joined with ` >>> `. */
	target: string[];
	html: string;
	failureSummary: string | null;
}

/** One axe rule that fired in one scene+theme. Raw axe results are far too
 * large for a run directory; this is the compact row `harness/score.ts` reads. */
export interface A11yViolation {
	id: string;
	/** axe's `null` impact is recorded as `unknown`, never dropped. */
	impact: 'critical' | 'serious' | 'moderate' | 'minor' | 'unknown';
	help: string;
	helpUrl: string;
	nodes: A11yNode[];
}

export interface CaptureOptions {
	buildDir: string;
	outDir: string;
	ai?: AiHandler;
	/** Run axe (WCAG 2.0/2.1 A and AA) after the scene settles and record
	 * compact violations on each result. Off by default, so `shots` output is
	 * unchanged. */
	a11y?: boolean;
	/** Called once per finished scene+theme capture (progress reporting). */
	onResult?: (result: SceneResult) => void;
}

export interface SceneResult {
	scene: string;
	theme: Theme;
	file: string;
	stable: boolean;
	frames: number;
	pageErrors: string[];
	/** Errors a scene explicitly expects (see Scene.allowPageErrors). */
	knownPageErrors: string[];
	consoleErrors: string[];
	failedRequests: string[];
	missingText: string[];
	/** Why `run` threw, or null when the scene reached its state. */
	error: string | null;
	/** Present only when captured with `a11y: true`; one entry per rule. */
	a11yViolations?: A11yViolation[];
	/** Rules axe could not evaluate (e.g. an overlapped element); present
	 * only with `a11y: true`. Non-empty means the surface was not audited. */
	a11yIncomplete?: A11yViolation[];
	/** Why axe could not analyze the page; null when it ran. Present only with
	 * `a11y: true`, so an empty violation list cannot hide an analysis failure. */
	a11yError?: string | null;
}

// Chromium logs this for any ResizeObserver whose callback resizes its own
// target; the app's stage and label measuring trip it, and it is not a defect.
const BENIGN_CONSOLE = [/ResizeObserver loop/];

const MAX_FRAMES = 8;

/** The conformance floor the app targets: WCAG 2.0 and 2.1, levels A and AA. */
const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Apply the scene's masks to every text node (documented escape hatch for
 * clock-derived copy). Narrow by construction: a pattern that matches
 * nothing leaves the DOM untouched. */
async function maskVolatileText(page: Page, masks: readonly TextMask[]): Promise<void> {
	await page.evaluate((rules) => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) nodes.push(walker.currentNode as Text);
		for (const node of nodes) {
			let text = node.data;
			for (const rule of rules) {
				text = text.replace(new RegExp(rule.source, rule.flags), rule.replacement);
			}
			if (text !== node.data) node.data = text;
		}
		// Form values are not text nodes: the settings endpoint carries the
		// harness server's random port, which would differ on every launch.
		for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
			'input, textarea'
		)) {
			let value = field.value;
			for (const rule of rules) {
				value = value.replace(new RegExp(rule.source, rule.flags), rule.replacement);
			}
			if (value !== field.value) field.value = value;
		}
	}, masks.map((rule) => ({ source: rule.pattern.source, flags: rule.pattern.flags, replacement: rule.replacement })));
}

/** Wait for finite animations before axe. The screenshot loop disables
 * animations *for the shot*, so two identical frames do not prove the page is
 * animation-free; a live fade would let axe read a blended color. Infinite
 * animations (the shimmer) are skipped. */
async function settleAnimations(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const running = document.getAnimations().filter((animation) => {
			const timing = animation.effect?.getComputedTiming();
			return (
				animation.playState === 'running' &&
				timing !== undefined &&
				timing.endTime !== Infinity
			);
		});
		const done = Promise.all(running.map((animation) => animation.finished.catch(() => {})));
		const { promise: cap, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 500);
		await Promise.race([done, cap]);
	});
}

/** Screenshots until two consecutive frames are byte-identical, the same idea
 * as Playwright's toHaveScreenshot stabilisation (which is test-runner only). */
async function stableScreenshot(
	page: Page,
	masks: readonly TextMask[] = []
): Promise<{ png: Buffer; stable: boolean; frames: number }> {
	await page.evaluate(() => document.fonts.ready);
	await maskVolatileText(page, masks);
	let previous: Buffer | null = null;
	for (let frames = 1; frames <= MAX_FRAMES; frames++) {
		const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
		if (previous !== null && png.equals(previous)) return { png, stable: true, frames };
		previous = png;
	}
	if (process.env.HARNESS_DEBUG_UNSTABLE === '1') {
		const animations = await page.evaluate(() =>
			document.getAnimations().map((animation) => `${animation.animationName}:${animation.playState}`)
		);
		console.error('[harness] unstable animations:', animations.join(', ') || '(none)');
	}
	return { png: previous as Buffer, stable: false, frames: MAX_FRAMES };
}

async function wireRelays(
	context: BrowserContext,
	relays: Map<string, FakeRelay>,
	refused: ReadonlySet<string>
): Promise<void> {
	await context.routeWebSocket(/^wss?:\/\/[^/]+\.test(?::\d+)?\/?$/, (ws) => {
		const host = new URL(ws.url()).hostname;
		if (refused.has(host)) {
			// An unreachable relay: the socket dies before NIP-01, and the
			// app's transport records the leg `refused` (spec §4).
			ws.close({ code: 1008, reason: 'harness: relay refused' });
			return;
		}
		const relay = relays.get(host);
		if (relay === undefined) {
			ws.close({ code: 1008, reason: 'harness: unknown relay host' });
			return;
		}
		ws.onMessage((message) => relay.handle(String(message), (frame) => ws.send(frame)));
	});
	await context.route(/^https?:\/\/[^/]+\.test(?::\d+)?\//, (route) => {
		const relay = relays.get(new URL(route.request().url()).hostname);
		if (relay === undefined) return route.abort();
		return route.fulfill({
			json: relay.infoDocument(),
			headers: { 'access-control-allow-origin': '*' }
		});
	});
}

export async function captureScenes(
	scenes: readonly Scene[],
	options: CaptureOptions,
	only?: { theme?: Theme }
): Promise<SceneResult[]> {
	mkdirSync(options.outDir, { recursive: true });
	const browser = await chromium.launch({
		args: ['--disable-lcd-text', '--font-render-hinting=none']
	});
	const results: SceneResult[] = [];
	try {
		for (const scene of scenes) {
		const stub = createAiStub(scene.ai ?? {});
		const server = await serveApp({
			buildDir: options.buildDir,
			ai: scene.ai === undefined ? (options.ai ?? stub.handler) : stub.handler,
			env: {
				PUBLIC_RELAY_URLS: scene.relays.map((r) => `ws://${r.host}`).join(','),
				PUBLIC_LLM_ENDPOINT: '{origin}/v1',
				// Fixtures carry canonical tags only.
				PUBLIC_INCLUDE_TEST_TAGS: '0',
				...scene.env
			}
		});
		try {
			for (const theme of only?.theme ? [only.theme] : (scene.themes ?? ['light', 'dark'])) {
				// Per-theme relays and stub: script cursors, held requests and
				// recorded frames describe exactly the shot being taken.
				const refused = new Set(
					scene.relays.filter((spec) => spec.refuse === true).map((spec) => spec.host)
				);
				const relays = new Map(
					scene.relays.map((spec) => [
						spec.host,
						new FakeRelay({ name: spec.host, events: spec.events, chaos: spec.chaos })
					])
				);
				let context: BrowserContext | null = null;
				try {
					context = await browser.newContext({
						viewport: scene.viewport ?? { width: 1440, height: 900 },
						deviceScaleFactor: 1,
						locale: 'en-US',
						timezoneId: 'UTC',
						colorScheme: theme,
						// The app honours reduced motion with its own floor; captures show what
						// a default browser shows.
						reducedMotion: 'no-preference'
					});
					await context.clock.setFixedTime(PAGE_NOW_MS);
					if (scene.apiKey === true) {
						await context.addInitScript(() =>
							sessionStorage.setItem('scrutiny.apiKey', 'harness-key')
						);
					}
					await wireRelays(context, relays, refused);
					const page = await context.newPage();
					const pageErrors: string[] = [];
					const knownPageErrors: string[] = [];
					const consoleErrors: string[] = [];
					const failedRequests: string[] = [];
					page.on('pageerror', (error) => {
						const text = error.message;
						if (scene.allowPageErrors?.some((pattern) => pattern.test(text)) === true) {
							knownPageErrors.push(text);
							return;
						}
						pageErrors.push(text);
					});
					page.on('console', (message) => {
						if (message.type() !== 'error') return;
						const text = message.text();
						if (!BENIGN_CONSOLE.some((pattern) => pattern.test(text))) consoleErrors.push(text);
					});
					page.on('requestfailed', (request) => {
						failedRequests.push(`${request.method()} ${request.url()}`);
					});

					// A failed scene still gets a screenshot and facts: the broken state is
					// the evidence a person or agent needs to see.
					let error: string | null = null;
					try {
						await scene.run({ page, url: server.url, relays, ai: stub.control });
					} catch (caught) {
						error = caught instanceof Error ? caught.message : String(caught);
					}

					const body = page.locator('body');
					const missingText: string[] = [];
					for (const text of scene.expect) {
						const visible = await body
							.getByText(text, { exact: false })
							.first()
							.isVisible()
							.catch(() => false);
						if (!visible) missingText.push(text);
					}
					const shot = await stableScreenshot(page, scene.mask);

					// Accessibility facts are taken AFTER the stabilisation loop: a
					// 160ms profile fade or a running transition can blend text toward
					// the surface and fake a contrast failure if axe reads mid-flight.
					// An axe failure is recorded, never turned into an empty pass.
					let a11yViolations: A11yViolation[] | undefined;
					let a11yIncomplete: A11yViolation[] | undefined;
					let a11yError: string | null | undefined;
					if (options.a11y === true) {
						try {
							// The page's stripe pattern is decorative; axe cannot
							// compute contrast over a gradient. Audit against the
							// solid --stripe-bg underneath (the screenshot still
							// shows the stripes).
							await page.evaluate(() => {
								document.body.style.backgroundImage = 'none';
							});
							await scene.a11yPrep?.({ page, url: server.url, relays, ai: stub.control });
							await settleAnimations(page);
							const analysis = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
							a11yViolations = compactViolations(analysis.violations);
							a11yIncomplete = compactViolations(analysis.incomplete);
							a11yError = null;
						} catch (caught) {
							a11yViolations = [];
							a11yIncomplete = [];
							a11yError = caught instanceof Error ? caught.message : String(caught);
						}
					}

					const name = `${scene.id}.${theme}`;
					const file = join(options.outDir, `${name}.png`);
					writeFileSync(file, shot.png);
					const result: SceneResult = {
						scene: scene.id,
						theme,
						file,
						stable: shot.stable,
						frames: shot.frames,
						pageErrors,
						knownPageErrors,
						consoleErrors,
						failedRequests,
						missingText,
						error
					};
					if (a11yViolations !== undefined) {
						result.a11yViolations = a11yViolations;
						result.a11yIncomplete = a11yIncomplete ?? [];
						result.a11yError = a11yError ?? null;
					}
					writeFileSync(
						join(options.outDir, `${name}.json`),
						`${JSON.stringify(
							{
								...result,
								text: await body.innerText(),
								relayFrames: Object.fromEntries(
									[...relays].map(([host, relay]) => [host, relay.received])
								)
							},
							null,
							2
						)}\n`
					);
					results.push(result);
					options.onResult?.(result);
				} finally {
					await context?.close();
				}
			}
		} finally {
			await server.close();
		}
		}
	} finally {
		await browser.close();
	}
	return results;
}
