// pnpm harness <command>
//
//   seed                      regenerate harness/fixtures/*.ndjson
//   list                      scene ids as JSON
//   shots [--label L] [--scene ID] [--theme light|dark]
//                             capture scenes into .harness/runs/<label>/
//   ledger [--runs N]         capture N times, write .harness/noise.json
//                             (the per-scene noise floor compare must clear)
//
// stdout is machine-readable JSON; progress goes to stderr. The app must be
// built first (`pnpm build`); the harness serves ./build.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureScenes, type Theme } from './capture.ts';
import { fixturePath } from './fixtures.ts';
import { runLedger } from './ledger.ts';
import { buildScenes } from './scenes/index.ts';
import { buildChains } from './seed/chains.ts';

function flag(args: string[], name: string): string | undefined {
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
	const all = buildScenes();
	const scenes = sceneId === undefined ? all : all.filter((scene) => scene.id === sceneId);
	if (scenes.length === 0) {
		console.error(`no scene "${sceneId}"`);
		process.exit(2);
	}
	const results = await captureScenes(
		scenes,
		{ buildDir: 'build', outDir: join('.harness', 'runs', label) },
		{ theme }
	);
	console.log(JSON.stringify(results, null, 2));
	const bad = results.filter(
		(r) => !r.stable || r.error !== null || r.pageErrors.length > 0 || r.missingText.length > 0
	);
	process.exit(bad.length === 0 ? 0 : 1);
} else if (command === 'ledger') {
	const floor = await runLedger(buildScenes(), 'build', Number(flag(args, 'runs') ?? 5));
	console.log(JSON.stringify(floor, null, 2));
	process.exit(Object.values(floor).every((entry) => entry.distinct === 1) ? 0 : 1);
} else {
	console.error('usage: harness seed | list | shots [--label L] [--scene ID] [--theme T] | ledger [--runs N]');
	process.exit(2);
}
