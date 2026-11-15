// pnpm harness <command>
//
//   seed                      regenerate harness/fixtures/*.ndjson
//   list                      scene ids as JSON
//   shots [--label L] [--scene ID] [--theme light|dark] [--build-dir DIR]
//                             capture scenes into .harness/runs/<label>/
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
import { captureScenes, type Theme } from './capture.ts';
import { runCompare } from './compare.ts';
import { fixturePath } from './fixtures.ts';
import { runLedger } from './ledger.ts';
import { writeRunMeta } from './runmeta.ts';
import { buildScenes } from './scenes/index.ts';
import { buildChains } from './seed/chains.ts';

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
	console.log(JSON.stringify({ fixture: 'chains', events: events.length }));
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
			'ledger [--runs N] | compare --base last|run:<label>|main [--head L] [--scene ID] [--json=summary|full]'
	);
	process.exit(2);
}
