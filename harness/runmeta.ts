// Provenance for one capture: what code, what browser, what fixtures.
// compare refuses cross-browser diffs and warns when a sibling checkout moved,
// because a design-system commit repaints every scene while this repo's diff is
// empty (plan run.json note).
//
// The sibling checkouts are `file:` deps, so their HEADs are part of the build.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { chromium } from 'playwright';
import { NOISE_FILE } from './ledger.ts';
import { fixturePath } from './fixtures.ts';
import { T0 } from './time.ts';

/** Repo root, resolved from this file so the commands work from any cwd. */
export const REPO_ROOT = join(import.meta.dirname, '..');

export const SIBLINGS = {
	fabricTools: join(REPO_ROOT, '..', 'scrutiny-fabric-tools'),
	designSystem: join(REPO_ROOT, '..', 'scrutiny-design-system')
} as const;

export interface RepoState {
	/** Absolute path as recorded; relative paths read better in a diff. */
	path: string;
	sha: string | null;
	/** Tracked changes (staged or not). Untracked files are reported apart. */
	dirty: boolean | null;
	untracked: boolean | null;
}

export interface RunMeta {
	schema: 1;
	label: string;
	/** Wall clock of the capture, for a human reading run.json. */
	createdAt: string;
	/** The fixture epoch every capture is pinned to. */
	t0: number;
	node: string;
	playwright: string;
	chromium: string;
	buildDir: string;
	scenes: string[];
	/** Code commit the served build came from when it is not this checkout
	 * (a `--base main` worktree build); null means `lens.sha`. */
	sourceSha: string | null;
	lens: RepoState;
	fabricTools: RepoState;
	designSystem: RepoState;
	/** sha256 per fixture file, keyed by file name. */
	fixtures: Record<string, string>;
	/** sha256 of the noise floor compare used at capture time, null if absent. */
	noise: string | null;
}

const require = createRequire(import.meta.url);

function git(dir: string, args: string[]): string | null {
	try {
		return execFileSync('git', ['-C', dir, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

/** `git status` exits 128 outside a repo; null says "not a checkout". */
export function repoState(dir: string): RepoState {
	const sha = git(dir, ['rev-parse', 'HEAD']);
	if (sha === null) return { path: shortPath(dir), sha: null, dirty: null, untracked: null };
	const tracked = git(dir, ['status', '--porcelain', '--untracked-files=no']);
	const all = git(dir, ['status', '--porcelain']);
	return {
		path: shortPath(dir),
		sha,
		dirty: tracked === null ? null : tracked !== '',
		untracked: all === null ? null : all !== ''
	};
}

/** Record absolute paths relative to the repo's parent so a log is portable. */
function shortPath(dir: string): string {
	const rel = relative(join(REPO_ROOT, '..'), dir).split('\\').join('/');
	return rel === '' ? '.' : rel;
}

function sha256File(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Fixture files ship in the repo; the checksum is what makes a screenshot
 * attributable to data rather than only to code. */
export function fixtureChecksums(): Record<string, string> {
	const dir = dirname(fixturePath('x'));
	const checksums: Record<string, string> = {};
	if (!existsSync(dir)) return checksums;
	for (const name of readdirSync(dir).filter((file) => file.endsWith('.ndjson')).sort()) {
		checksums[name] = sha256File(join(dir, name));
	}
	return checksums;
}

export function playwrightVersion(): string {
	try {
		const packageFile = require.resolve('playwright/package.json');
		const packageJson: unknown = JSON.parse(readFileSync(packageFile, 'utf8'));
		if (
			typeof packageJson === 'object' &&
			packageJson !== null &&
			'version' in packageJson &&
			typeof packageJson.version === 'string'
		) {
			return packageJson.version;
		}
		return 'unknown';
	} catch {
		return 'unknown';
	}
}

/** The bundled Chromium build is the renderer a screenshot depends on; capture
 * launches with the same default channel, so this version is authoritative.
 * Exported so compare can refuse a cross-browser diff before spending a capture. */
export async function chromiumVersion(): Promise<string> {
	const browser = await chromium.launch();
	try {
		return browser.version();
	} finally {
		await browser.close();
	}
}

export async function writeRunMeta(input: {
	label: string;
	outDir: string;
	buildDir: string;
	scenes: readonly string[];
	/** Set when the build came from another commit (a base worktree). */
	sourceSha?: string | null;
}): Promise<RunMeta> {
	const noiseFile = join(REPO_ROOT, NOISE_FILE);
	const meta: RunMeta = {
		schema: 1,
		label: input.label,
		createdAt: new Date().toISOString(),
		t0: T0,
		node: process.version,
		playwright: playwrightVersion(),
		chromium: await chromiumVersion(),
		buildDir: shortPath(isAbsolute(input.buildDir) ? input.buildDir : join(REPO_ROOT, input.buildDir)),
		scenes: [...input.scenes].sort(),
		sourceSha: input.sourceSha ?? null,
		lens: repoState(REPO_ROOT),
		fabricTools: repoState(SIBLINGS.fabricTools),
		designSystem: repoState(SIBLINGS.designSystem),
		fixtures: fixtureChecksums(),
		noise: existsSync(noiseFile) ? sha256File(noiseFile) : null
	};
	writeFileSync(join(input.outDir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
	return meta;
}

/** Only the fields compare actually checks; anything else may drift. */
function isRunMeta(value: unknown): value is RunMeta {
	if (typeof value !== 'object' || value === null) return false;
	if (!('schema' in value && value.schema === 1)) return false;
	if (!('chromium' in value && typeof value.chromium === 'string')) return false;
	if (!('label' in value && typeof value.label === 'string')) return false;
	if ('sourceSha' in value && value.sourceSha !== null && typeof value.sourceSha !== 'string') {
		return false;
	}
	return (
		'fixtures' in value &&
		typeof value.fixtures === 'object' &&
		value.fixtures !== null &&
		'fabricTools' in value &&
		typeof value.fabricTools === 'object' &&
		value.fabricTools !== null &&
		'designSystem' in value &&
		typeof value.designSystem === 'object' &&
		value.designSystem !== null &&
		'noise' in value &&
		(value.noise === null || typeof value.noise === 'string')
	);
}

export function readRunMeta(runDir: string): RunMeta | null {
	const file = join(runDir, 'run.json');
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		// A run.json from another harness version cannot answer the checks
		// compare relies on; treat it as absent rather than half-trust it.
		return isRunMeta(parsed) ? { ...parsed, sourceSha: parsed.sourceSha ?? null } : null;
	} catch {
		return null;
	}
}
