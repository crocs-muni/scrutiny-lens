// pnpm harness <command>
//
//   seed                      regenerate harness/fixtures/*.ndjson
//   list                      scene ids as JSON
//   shots [--label L] [--scene ID] [--theme light|dark] [--build-dir DIR]
//                             capture scenes into .harness/runs/<label>/
//   a11y [--label L] [--scene ID] [--theme light|dark]
//                             capture with axe (WCAG 2.0/2.1 A+AA); JSON
//                             summary to stdout, exit 1 on any violation,
//                             2 when a capture or the analysis failed
//   ledger [--runs N]         capture N times, write .harness/noise.json
//                             (the per-scene noise floor compare must clear)
//   compare --base last|run:<label>|main [--head <label>] [--scene ID]
//           [--json=summary|full]
//                             diff two runs; exit 0 unchanged, 1 changed,
//                             2 error
//
// stdout is machine-readable JSON; progress goes to stderr. The app must be
// built first (`pnpm build`); the harness serves ./build unless --build-dir.
// `pnpm harness` prepends pnpm's own banner to stdout; scripts that parse the
// JSON call `pnpm -s harness ...`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeA11y } from './a11y.ts';
import { captureScenes, type Theme } from './capture.ts';
import { runCompare } from './compare.ts';
import { fixturePath } from './fixtures.ts';
import { runLedger } from './ledger.ts';
import { writeRunMeta } from './runmeta.ts';
import { buildScenes } from './scenes/index.ts';
import { buildChains, buildAbortedChain } from './seed/chains.ts';

/** `--name value` or `--name=value`; the second form is what loops write. */
function flag(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = args.find((arg) => arg.startsWith(prefix));
	if (inline !== undefined) return inline.slice(prefix.length);
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
}

const [command, ...args] = process.argv.slice(2);

if (command === 'seed') {
	mkdirSync(join(import.meta.dirname, 'fixtures'), { recursive: true });
	const events = buildChains();
	writeFileSync(fixturePath('chains'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
	const aborted = buildAbortedChain();
	writeFileSync(fixturePath('chains-aborted'), `${aborted.map((e) => JSON.stringify(e)).join('\n')}\n`);
	console.log(JSON.stringify({ fixture: 'chains', events: events.length, aborted: aborted.length }));
} else if (command === 'list') {
	console.log(JSON.stringify(buildScenes().map((scene) => scene.id)));
} else if (command === 'shots') {
	const label = flag(args, 'label') ?? 'head';
	const sceneId = flag(args, 'scene');
	const theme = flag(args, 'theme') as Theme | undefined;
	const buildDir = flag(args, 'build-dir') ?? 'build';
	const all = buildScenes();
	const scenes = sceneId === undefined ? all : all.filter((scene) => scene.id === sceneId);
	if (scenes.length === 0) {
		console.error(`no scene "${sceneId}"`);
		process.exit(2);
	}
	const outDir = join('.harness', 'runs', label);
	const results = await captureScenes(scenes, { buildDir, outDir }, { theme });
	await writeRunMeta({ label, outDir, buildDir, scenes: scenes.map((scene) => scene.id) });
	console.log(JSON.stringify(results, null, 2));
	const bad = results.filter(
		(r) => !r.stable || r.error !== null || r.pageErrors.length > 0 || r.missingText.length > 0
	);
	process.exit(bad.length === 0 ? 0 : 1);
} else if (command === 'a11y') {
	const label = flag(args, 'label') ?? 'a11y';
	const sceneId = flag(args, 'scene');
	const theme = flag(args, 'theme') as Theme | undefined;
	if (theme !== undefined && theme !== 'light' && theme !== 'dark') {
		console.error(`--theme must be light or dark, not "${theme}"`);
		process.exit(2);
	}
	const scenes =
		sceneId === undefined ? buildScenes() : buildScenes().filter((scene) => scene.id === sceneId);
	if (scenes.length === 0) {
		console.error(`no scene "${sceneId}"`);
		process.exit(2);
	}
	const outDir = join('.harness', 'runs', label);
	console.error(`a11y: capturing ${scenes.length} scene(s) into ${outDir}`);
	const results = await captureScenes(
		scenes,
		{
			buildDir: 'build',
			outDir,
			a11y: true,
			onResult: (result) => {
				const rules = result.a11yViolations ?? [];
				const nodes = rules.reduce((total, rule) => total + rule.nodes.length, 0);
				const failed =
					result.a11yError === null || result.a11yError === undefined
						? ''
						: ` (analysis failed: ${result.a11yError})`;
				console.error(
					`a11y ${result.scene}.${result.theme}: ${rules.length} rule instance(s), ` +
						`${nodes} node(s)${failed}`
				);
			}
		},
		{ theme }
	);
	await writeRunMeta({ label, outDir, buildDir: 'build', scenes: scenes.map((scene) => scene.id) });
	const summary = summarizeA11y(results, label);
	console.log(JSON.stringify(summary, null, 2));
	console.error(
		`a11y: ${summary.violations} rule instance(s), ${summary.nodes} node(s) across ` +
			`${summary.rules} rule(s); ${summary.incomplete.nodes} incomplete node(s); ` +
			`${summary.errors.length} analysis error(s)`
	);
	const broken =
		summary.errors.length > 0 ||
		summary.incomplete.nodes > 0 ||
		results.some((result) => result.error !== null);
	process.exit(broken ? 2 : summary.violations > 0 ? 1 : 0);
} else if (command === 'ledger') {
	const floor = await runLedger(buildScenes(), 'build', Number(flag(args, 'runs') ?? 5));
	console.log(JSON.stringify(floor, null, 2));
	process.exit(Object.values(floor).every((entry) => entry.distinct === 1) ? 0 : 1);
} else if (command === 'compare') {
	const base = flag(args, 'base');
	if (base === undefined) {
		console.error('compare needs --base last|run:<label>|main');
		process.exit(2);
	}
	const json = flag(args, 'json') ?? 'summary';
	if (json !== 'summary' && json !== 'full') {
		console.error(`--json must be summary or full, not "${json}"`);
		process.exit(2);
	}
	try {
		const result = await runCompare({
			base,
			head: flag(args, 'head'),
			scene: flag(args, 'scene')
		});
		const { summary, ...full } = result;
		console.log(JSON.stringify(json === 'full' ? full : summary, null, 2));
		console.error(
			`compare: ${result.verdict}; ${result.entries.length} capture(s), ` +
				`${result.score.changedScenes} changed; report ${join(result.dir, 'index.html')}`
		);
		process.exit(result.verdict === 'changed' ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
} else {
	console.error(
		'usage: harness seed | list | shots [--label L] [--scene ID] [--theme T] [--build-dir DIR] | ' +
			'a11y [--label L] [--scene ID] [--theme T] | ' +
			'ledger [--runs N] | compare --base last|run:<label>|main [--head L] [--scene ID] [--json=summary|full]'
	);
	process.exit(2);
}
