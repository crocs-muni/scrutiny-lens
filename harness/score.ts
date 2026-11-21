// Frozen scoreboard for one harness run: the facts a climb may improve, in
// one JSON object. Read-only by construction — it parses the run directory,
// never the app or the scenes, so a loop cannot move the goalposts.
//
//   node harness/score.ts --run .harness/runs/climb-base
//
// `a11y` is present only when the run was captured with `harness a11y`; the
// counts are rule-instance counts, not rule counts, so one repeated contrast
// failure cannot look like one issue.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SceneFact {
	scene: string;
	theme: string;
	stable: boolean;
	pageErrors: string[];
	knownPageErrors: string[];
	consoleErrors: string[];
	failedRequests: string[];
	missingText: string[];
	error: string | null;
	a11yViolations?: Array<{ id: string; impact?: string | null; nodes: unknown[] }>;
	a11yIncomplete?: Array<{ id: string; impact?: string | null; nodes: unknown[] }>;
	a11yError?: string | null;
}

function flag(args: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = args.find((arg) => arg.startsWith(prefix));
	if (inline !== undefined) return inline.slice(prefix.length);
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
}

const args = process.argv.slice(2);
const runDir = flag(args, 'run');
if (runDir === undefined) {
	console.error('usage: node harness/score.ts --run <run-dir>');
	process.exit(2);
}

const files = readdirSync(runDir)
	.filter((name) => name.endsWith('.json') && name !== 'run.json')
	.sort();
const rows: SceneFact[] = files.map((name) => JSON.parse(readFileSync(join(runDir, name), 'utf8')) as SceneFact);

const byImpact: Record<string, number> = {};
let a11yRules = 0;
let a11yNodes = 0;
let a11yIncompleteNodes = 0;
let a11yErrors = 0;
for (const row of rows) {
	if (row.a11yError !== undefined && row.a11yError !== null) a11yErrors += 1;
	for (const violation of row.a11yViolations ?? []) {
		a11yRules += 1;
		a11yNodes += violation.nodes.length;
		const impact = violation.impact ?? 'unknown';
		byImpact[impact] = (byImpact[impact] ?? 0) + violation.nodes.length;
	}
	for (const violation of row.a11yIncomplete ?? []) {
		a11yIncompleteNodes += violation.nodes.length;
	}
}

const offenders = rows
	.filter(
		(row) =>
			row.missingText.length > 0 ||
			row.pageErrors.length > 0 ||
			row.consoleErrors.length > 0 ||
			row.failedRequests.length > 0 ||
			row.error !== null ||
			!row.stable
	)
	.map((row) => row.scene);

const score = {
	run: runDir,
	scenes: new Set(rows.map((row) => row.scene)).size,
	themes: rows.length,
	missingText: rows.reduce((n, row) => n + row.missingText.length, 0),
	sceneErrors: rows.filter((row) => row.error !== null).length,
	pageErrors: rows.reduce((n, row) => n + row.pageErrors.length, 0),
	knownPageErrors: rows.reduce((n, row) => n + row.knownPageErrors.length, 0),
	consoleErrors: rows.reduce((n, row) => n + row.consoleErrors.length, 0),
	failedRequests: rows.reduce((n, row) => n + row.failedRequests.length, 0),
	unstable: rows.filter((row) => !row.stable).length,
	a11y: {
		ruleInstances: a11yRules,
		nodes: a11yNodes,
		incompleteNodes: a11yIncompleteNodes,
		errors: a11yErrors,
		byImpact
	},
	offenders: [...new Set(offenders)].sort()
};

console.log(JSON.stringify(score, null, 2));

// `--gate` is the climb's keep/revert decision: an intentional 500/429 logs a
// console error, so that bucket stays informational; an unhandled page error,
// a failed request, missing expected text, an unstable shot, an axe failure,
// an incomplete axe audit, or a serious/critical finding fails the run.
if (args.includes('--gate')) {
	const serious = (score.a11y.byImpact.serious ?? 0) + (score.a11y.byImpact.critical ?? 0);
	const failed =
		score.missingText > 0 ||
		score.sceneErrors > 0 ||
		score.pageErrors > 0 ||
		score.failedRequests > 0 ||
		score.unstable > 0 ||
		score.a11y.incompleteNodes > 0 ||
		score.a11y.errors > 0 ||
		serious > 0 ||
		(args.includes('--strict') && score.knownPageErrors > 0);
	process.exit(failed ? 1 : 0);
}
