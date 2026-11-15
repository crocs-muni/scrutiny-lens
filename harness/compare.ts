// `harness compare`: diff two capture runs on the same machine and write a
// local, self-contained report.
//
// The pixel verdict is the noise floor from `harness ledger`, not "any pixel
// differs": dashed borders and subpixel text antialiasing disagree with
// themselves between runs. Facts (DOM text, page/console errors) are compared
// separately so a change that renders no pixels still fails the run.
//
// Bases:
//   last        the newest run dir except the head one
//   run:<label> an existing run
//   main        capture origin/main from a sibling worktree (harness code stays
//               this checkout's, because origin/main has no harness/ yet)

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { captureScenes, type Theme } from './capture.ts';
import { diffPngs } from './diff.ts';
import { NOISE_FILE } from './ledger.ts';
import { renderCompareReport } from './report.ts';
import { REPO_ROOT, chromiumVersion, readRunMeta, writeRunMeta, type RunMeta } from './runmeta.ts';
import { buildScenes } from './scenes/index.ts';

const RUNS_DIR = join(REPO_ROOT, '.harness', 'runs');
const COMPARE_DIR = join(REPO_ROOT, '.harness', 'compare');
const BUILD_DIR = join(REPO_ROOT, 'build');
const WORKTREE = resolve(REPO_ROOT, '..', 'scrutiny-lens.harness-base');

export type Verdict = 'unchanged' | 'changed' | 'new' | 'removed' | 'size-mismatch';

export interface Score {
	/** Scene+theme entries whose verdict is not `unchanged`; each theme counts. */
	changedScenes: number;
	changedPixels: number;
	addedTextLines: number;
	removedTextLines: number;
	newErrors: number;
}

export interface RunSide {
	label: string;
	dir: string;
	meta: RunMeta | null;
}

export interface SceneComparison {
	scene: string;
	theme: Theme;
	/** `<scene>.<theme>`, the key shared by PNG, JSON and noise floor. */
	id: string;
	verdict: Verdict;
	pixels: number;
	ratio: number;
	bounds: [number, number, number, number] | null;
	/** `[base, head]` image dimensions when they disagree. */
	sizeMismatch: [string, string] | null;
	textAdded: string[];
	textRemoved: string[];
	newPageErrors: string[];
	newConsoleErrors: string[];
	newFailedRequests: string[];
	newMissingText: string[];
	/** Scene `run()` errors on the head side that the base did not have. */
	newSceneError: string | null;
	factsChanged: boolean;
	stableBase: boolean | null;
	stableHead: boolean | null;
	/** Paths relative to the compare dir; null when that side has no PNG. */
	images: { base: string | null; head: string | null; diff: string | null };
}

export interface CompareResult {
	base: RunSide;
	head: RunSide;
	/** Compare dir under .harness/compare; index.html, summary.json, full.json live here. */
	dir: string;
	noise: { file: boolean; checksum: string | null; entries: number };
	warnings: string[];
	entries: SceneComparison[];
	score: Score;
	verdict: 'unchanged' | 'changed';
}

export interface SummaryEntry {
	id: string;
	verdict: Verdict;
	pixels: number;
	ratio: number;
	bounds?: [number, number, number, number];
	text?: { added: number; removed: number };
	errors?: { page: number; console: number; failed: number; missing: number; scene: number };
	factsChanged?: boolean;
}

export interface Summary {
	base: { label: string; sha: string | null; browser: string | null };
	head: { label: string; sha: string | null; browser: string | null };
	verdict: 'unchanged' | 'changed';
	browsersMatch: boolean;
	noise: { file: boolean; entries: number };
	score: Score;
	scenes: SummaryEntry[];
	/** Set instead of `scenes` entries when the payload would exceed 2 KB. */
	unchangedCount?: number;
	/** Changed entries beyond the 2 KB cap; the score still counts them. */
	omittedEntries?: number;
	warnings: string[];
}

export class CompareError extends Error {}

function git(args: string[], cwd = REPO_ROOT, quiet = false): string | null {
	try {
		return execFileSync('git', ['-C', cwd, ...args], {
			encoding: 'utf8',
			stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			timeout: 60_000
		}).trim();
	} catch {
		return null;
	}
}

/** pnpm resolves through a .cmd shim on Windows, which Node refuses to spawn
 * without a shell; cmd.exe is invoked explicitly so no user argument is ever
 * concatenated into a shell line. */
function runPnpm(args: string[], cwd: string): void {
	const options = { cwd, encoding: 'utf8' as const, timeout: 15 * 60_000 };
	const result =
		process.platform === 'win32'
			? spawnSync('cmd.exe', ['/d', '/s', '/c', ['pnpm', ...args].join(' ')], options)
			: spawnSync('pnpm', args, options);
	if (result.status !== 0) {
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-2000);
		throw new CompareError(`pnpm ${args.join(' ')} failed in ${cwd}\n${output}`);
	}
}

function hasRun(label: string): boolean {
	const dir = join(RUNS_DIR, label);
	return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith('.png'));
}

function newestRun(excluded: readonly string[]): string | null {
	if (!existsSync(RUNS_DIR)) return null;
	const candidates = readdirSync(RUNS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !excluded.includes(entry.name))
		.map((entry) => ({
			label: entry.name,
			mtime: statSync(join(RUNS_DIR, entry.name)).mtimeMs,
			meta: existsSync(join(RUNS_DIR, entry.name, 'run.json'))
		}))
		.filter((entry) => hasRun(entry.label))
		.sort((a, b) => b.mtime - a.mtime);
	// Ledger and spike dirs have no run.json; a base without provenance cannot
	// be checked for browser/sibling drift, so prefer captures that have one.
	return (candidates.find((entry) => entry.meta) ?? candidates[0])?.label ?? null;
}

/** Scenes the comparison needs, after `--scene`. */
function wantedScenes(sceneId?: string): readonly Scene[] {
	const all = buildScenes();
	const scenes = sceneId === undefined ? all : all.filter((scene) => scene.id === sceneId);
	if (scenes.length === 0) throw new CompareError(`no scene "${sceneId}"`);
	return scenes;
}

function runThemes(scene: Scene): readonly Theme[] {
	return scene.themes ?? (['light', 'dark'] as const);
}

/** A run dir can hold a subset (older `shots --scene` or `--theme`). Reusing it
 * would report the rest as new/removed, so ask which scenes it cannot answer. */
function coverageGaps(dir: string, scenes: readonly Scene[]): Scene[] {
	return scenes.filter((scene) =>
		runThemes(scene).some((theme) => !existsSync(join(dir, `${scene.id}.${theme}.png`)))
	);
}

/** Capture and record provenance; the only writer of run.json. */
async function capture(
	label: string,
	buildDir: string,
	scenes: readonly Scene[],
	options: { keepExisting?: boolean; sourceSha?: string | null } = {}
): Promise<RunSide> {
	if (scenes.length === 0) throw new CompareError('no scenes to capture');
	const outDir = join(RUNS_DIR, label);
	mkdirSync(outDir, { recursive: true });
	console.error(
		`compare: capturing ${scenes.map((scene) => scene.id).join(', ')} as "${label}" from ${buildDir}`
	);
	const results = await captureScenes(scenes, { buildDir, outDir });
	const keep = new Set(results.map((result) => `${result.scene}.${result.theme}`));
	for (const file of readdirSync(outDir)) {
		if (file.endsWith('.png') && options.keepExisting === true) keep.add(file.slice(0, -'.png'.length));
	}
	for (const file of readdirSync(outDir)) {
		if (file === 'run.json') continue;
		if (!file.endsWith('.png') && !file.endsWith('.json')) continue;
		if (!keep.has(file.replace(/\.(png|json)$/, ''))) rmSync(join(outDir, file));
	}
	const sceneIds = new Set([...keep].map((key) => key.slice(0, key.lastIndexOf('.'))));
	await writeRunMeta({
		label,
		outDir,
		buildDir,
		scenes: [...sceneIds],
		sourceSha: options.sourceSha ?? null
	});
	return { label, dir: outDir, meta: readRunMeta(outDir) };
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function worktreeRegistry(): string[] {
	const listing = git(['worktree', 'list', '--porcelain']);
	if (listing === null) return [];
	return listing
		.split('\n')
		.filter((line) => line.startsWith('worktree '))
		.map((line) => resolve(line.slice('worktree '.length)).toLowerCase());
}

function gitOrThrow(args: string[], cwd: string): void {
	const output = git(args, cwd);
	if (output === null) throw new CompareError(`git ${args.join(' ')} failed in ${cwd}`);
}

/** Make `../scrutiny-lens.harness-base` hold `sha` and return its build dir.
 * The worktree is reused, never deleted: a fresh `pnpm install` there costs
 * more than the disk it occupies, and deleting outside .harness/ is forbidden. */
function prepareMainWorktree(sha: string): string {
	const known = worktreeRegistry().includes(WORKTREE.toLowerCase());
	if (existsSync(WORKTREE) && !known) {
		throw new CompareError(
			`${WORKTREE} exists but is not a registered worktree of this repo; move it away before --base main`
		);
	}
	if (!existsSync(WORKTREE)) {
		gitOrThrow(['worktree', 'add', '--detach', WORKTREE, sha], REPO_ROOT);
	} else if (git(['rev-parse', 'HEAD'], WORKTREE) !== sha) {
		const dirty = git(['status', '--porcelain', '--untracked-files=no'], WORKTREE);
		if (dirty === null || dirty !== '') {
			throw new CompareError(
				`${WORKTREE} has local changes; clean it (or remove it) before --base main`
			);
		}
		gitOrThrow(['checkout', '--detach', sha], WORKTREE);
	}
	// file: deps make the worktree a build root of its own; the sibling rule
	// holds because the worktree sits next to this repo, at the same depth.
	runPnpm(['install', '--frozen-lockfile'], WORKTREE);
	runPnpm(['build'], WORKTREE);
	const built = join(WORKTREE, 'build');
	if (!existsSync(join(built, 'index.html'))) {
		throw new CompareError(`build/index.html missing in ${WORKTREE} after pnpm build`);
	}
	return built;
}

async function resolveBaseMain(sceneId?: string): Promise<RunSide> {
	// Offline is a normal state for a local loop; the cached ref is enough.
	git(['fetch', 'origin', 'main'], REPO_ROOT, true);
	const sha = git(['rev-parse', 'origin/main']);
	if (sha === null) throw new CompareError('cannot resolve origin/main (fetch failed and no local ref)');
	const label = `main-${shortSha(sha)}`;
	const wanted = wantedScenes(sceneId);
	const dir = join(RUNS_DIR, label);
	if (hasRun(label)) {
		const gaps = coverageGaps(dir, wanted);
		if (gaps.length === 0) return { label, dir, meta: readRunMeta(dir) };
		const buildDir = prepareMainWorktree(sha);
		return capture(label, buildDir, gaps, { keepExisting: true, sourceSha: sha });
	}
	const buildDir = prepareMainWorktree(sha);
	return capture(label, buildDir, wanted, { sourceSha: sha });
}

async function resolveHead(label: string | undefined, sceneId?: string): Promise<RunSide> {
	// No --head means "capture now": reusing a stale `head` dir would compare
	// yesterday's build against today's base.
	if (label === undefined) return capture('head', BUILD_DIR, wantedScenes(sceneId));
	// An explicit label is taken as-is: a run that lacks a scene reports it as
	// new/removed instead of silently capturing for minutes.
	if (!hasRun(label)) return capture(label, BUILD_DIR, wantedScenes(sceneId));
	const dir = join(RUNS_DIR, label);
	return { label, dir, meta: readRunMeta(dir) };
}

async function resolveBase(spec: string, headLabel: string, sceneId?: string): Promise<RunSide> {
	if (spec === 'main') return resolveBaseMain(sceneId);
	if (spec.startsWith('run:')) {
		const label = spec.slice('run:'.length);
		if (!hasRun(label)) throw new CompareError(`no run "${label}" (looked in .harness/runs)`);
		return { label, dir: join(RUNS_DIR, label), meta: readRunMeta(join(RUNS_DIR, label)) };
	}
	if (spec === 'last') {
		const label = newestRun([headLabel]);
		if (label === null) throw new CompareError('no previous run to compare against');
		return { label, dir: join(RUNS_DIR, label), meta: readRunMeta(join(RUNS_DIR, label)) };
	}
	throw new CompareError(`unknown base "${spec}"; use last, run:<label> or main`);
}

interface Facts {
	text: string;
	pageErrors: string[];
	consoleErrors: string[];
	failedRequests: string[];
	missingText: string[];
	sceneError: string | null;
	stable: boolean | null;
}

const EMPTY_FACTS: Facts = {
	text: '',
	pageErrors: [],
	consoleErrors: [],
	failedRequests: [],
	missingText: [],
	sceneError: null,
	stable: null
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Facts come off disk, so every field is validated before use. */
function readFacts(file: string): Facts {
	if (!existsSync(file)) return EMPTY_FACTS;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return EMPTY_FACTS;
	}
	if (typeof raw !== 'object' || raw === null) return EMPTY_FACTS;
	const record = raw as Record<string, unknown>; // parsed JSON: fields checked below
	return {
		text: typeof record.text === 'string' ? record.text : '',
		pageErrors: stringArray(record.pageErrors),
		consoleErrors: stringArray(record.consoleErrors),
		failedRequests: stringArray(record.failedRequests),
		missingText: stringArray(record.missingText),
		sceneError: typeof record.error === 'string' ? record.error : null,
		stable: typeof record.stable === 'boolean' ? record.stable : null
	};
}

/** Multiset difference, so a line repeated twice and removed once reports one
 * removal rather than vanishing. Removals keep base order. */
function multisetDiff(
	base: readonly string[],
	head: readonly string[]
): { added: string[]; removed: string[] } {
	const counts = new Map<string, number>();
	for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1);
	const added: string[] = [];
	for (const line of head) {
		const count = counts.get(line) ?? 0;
		if (count > 0) counts.set(line, count - 1);
		else added.push(line);
	}
	const removed: string[] = [];
	for (const [line, count] of counts) {
		for (let i = 0; i < count; i++) removed.push(line);
	}
	return { added, removed };
}

interface NoiseEntry {
	maxPixels: number;
}

function loadNoise(): { floor: Record<string, NoiseEntry>; file: boolean; checksum: string | null } {
	const file = join(REPO_ROOT, NOISE_FILE);
	if (!existsSync(file)) return { floor: {}, file: false, checksum: null };
	const bytes = readFileSync(file);
	const raw: unknown = JSON.parse(bytes.toString('utf8'));
	const floor: Record<string, NoiseEntry> = {};
	if (typeof raw === 'object' && raw !== null) {
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value !== 'object' || value === null) continue;
			if (!('maxPixels' in value) || typeof value.maxPixels !== 'number') continue;
			floor[key] = { maxPixels: value.maxPixels };
		}
	}
	return {
		floor,
		file: true,
		checksum: createHash('sha256').update(bytes).digest('hex')
	};
}

function safeName(label: string): string {
	return label.replace(/[^A-Za-z0-9._-]/g, '_');
}

function imageKeys(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith('.png'))
		.map((file) => file.slice(0, -'.png'.length))
		.sort();
}

function compareOne(
	id: string,
	baseDir: string,
	headDir: string,
	noiseFloor: number,
	theme: Theme,
	scene: string,
	images: { base: string | null; head: string | null; diff: string | null }
): { entry: SceneComparison; diffImage: Buffer | null } {
	const basePng = join(baseDir, `${id}.png`);
	const headPng = join(headDir, `${id}.png`);
	const baseFacts = readFacts(join(baseDir, `${id}.json`));
	const headFacts = readFacts(join(headDir, `${id}.json`));
	// Blank lines separate blocks in the DOM text; only content lines are diffed.
	const baseLines = baseFacts.text.split(/\r?\n/).filter((line) => line.trim() !== '');
	const headLines = headFacts.text.split(/\r?\n/).filter((line) => line.trim() !== '');
	const text = multisetDiff(baseLines, headLines);
	const pageErrors = multisetDiff(baseFacts.pageErrors, headFacts.pageErrors).added;
	const consoleErrors = multisetDiff(baseFacts.consoleErrors, headFacts.consoleErrors).added;
	const failedRequests = multisetDiff(baseFacts.failedRequests, headFacts.failedRequests).added;
	const missingText = multisetDiff(baseFacts.missingText, headFacts.missingText).added;
	const newSceneError =
		headFacts.sceneError !== null && headFacts.sceneError !== baseFacts.sceneError
			? headFacts.sceneError
			: null;
	const factsChanged =
		text.added.length > 0 ||
		text.removed.length > 0 ||
		pageErrors.length > 0 ||
		consoleErrors.length > 0 ||
		failedRequests.length > 0 ||
		missingText.length > 0 ||
		newSceneError !== null;

	let verdict: Verdict;
	let pixels = 0;
	let ratio = 0;
	let bounds: [number, number, number, number] | null = null;
	let sizeMismatch: [string, string] | null = null;
	let diffImage: Buffer | null = null;
	if (!existsSync(basePng)) {
		verdict = 'new';
	} else if (!existsSync(headPng)) {
		verdict = 'removed';
	} else {
		const diff = diffPngs(basePng, headPng);
		pixels = diff.pixels;
		ratio = diff.ratio;
		if (diff.sizeMismatch !== null) {
			verdict = 'size-mismatch';
			sizeMismatch = [
				`${diff.sizeMismatch.a[0]}x${diff.sizeMismatch.a[1]}`,
				`${diff.sizeMismatch.b[0]}x${diff.sizeMismatch.b[1]}`
			];
		} else if (pixels <= noiseFloor) {
			verdict = 'unchanged';
			bounds = null;
		} else {
			verdict = 'changed';
			const box = diff.bounds;
			bounds = box === null ? null : [box.x0, box.y0, box.x1, box.y1];
		}
		if (diff.image !== null && verdict !== 'unchanged') {
			images.diff = `diff/${id}.png`;
			diffImage = diff.image;
		}
	}
	return {
		entry: {
			scene,
			theme,
			id,
			verdict,
			pixels,
			ratio,
			bounds,
			sizeMismatch,
			textAdded: text.added,
			textRemoved: text.removed,
			newPageErrors: pageErrors,
			newConsoleErrors: consoleErrors,
			newFailedRequests: failedRequests,
			newMissingText: missingText,
			newSceneError,
			factsChanged,
			stableBase: baseFacts.stable,
			stableHead: headFacts.stable,
			images
		},
		diffImage
	};
}

export async function runCompare(request: {
	base: string;
	head?: string;
	scene?: string;
}): Promise<CompareResult & { summary: Summary }> {
	const headName = request.head ?? 'head';
	const base = await resolveBase(request.base, headName, request.scene);
	if ((request.head === undefined || !hasRun(headName)) && base.meta?.chromium) {
		// Refuse before spending a full capture on screenshots that cannot be
		// compared: the local browser is the one the fresh head would use.
		const local = await chromiumVersion();
		if (local !== base.meta.chromium) {
			throw new CompareError(
				`browser version differs (base ${base.meta.chromium}, local ${local}); screenshots are not comparable`
			);
		}
	}
	const head = await resolveHead(request.head, request.scene);
	const warnings: string[] = [];
	const baseMeta = base.meta;
	const headMeta = head.meta;
	if (baseMeta === null) warnings.push(`no run.json in base "${base.label}"`);
	if (headMeta === null) warnings.push(`no run.json in head "${head.label}"`);
	const baseBrowser = baseMeta?.chromium ?? null;
	const headBrowser = headMeta?.chromium ?? null;
	if (baseBrowser !== null && headBrowser !== null && baseBrowser !== headBrowser) {
		throw new CompareError(
			`browser version differs (base ${baseBrowser}, head ${headBrowser}); screenshots are not comparable`
		);
	}
	if (baseBrowser === null || headBrowser === null) {
		warnings.push('browser version unknown for one side; cross-version compare not ruled out');
	}
	for (const side of [base, head]) {
		const listed = side.meta?.scenes;
		if (listed === undefined) continue;
		const extra = new Set(
			imageKeys(side.dir)
				.map((id) => id.slice(0, id.lastIndexOf('.')))
				.filter((scene) => !listed.includes(scene))
		);
		if (extra.size > 0) {
			warnings.push(
				`${side.label}: ${extra.size} scene(s) on disk are not listed in run.json ` +
					'(interrupted or foreign capture)'
			);
		}
	}

	const noise = loadNoise();
	if (!noise.file) {
		warnings.push('no .harness/noise.json; every pixel difference counts (run pnpm harness ledger)');
	}

	const siblingKeys = ['fabricTools', 'designSystem'] as const;
	for (const key of siblingKeys) {
		const before = baseMeta?.[key];
		const after = headMeta?.[key];
		if (before === undefined || after === undefined) continue;
		if (before.sha !== after.sha) {
			warnings.push(
				`${key} HEAD differs (${before.sha ?? 'missing'} -> ${after.sha ?? 'missing'}); ` +
					'a sibling commit repaints every scene'
			);
		}
		if (before.dirty === true || after.dirty === true) {
			warnings.push(`${key} checkout was dirty during capture; its sha does not describe the build`);
		}
	}
	if (
		baseMeta !== null &&
		headMeta !== null &&
		JSON.stringify(baseMeta.fixtures) !== JSON.stringify(headMeta.fixtures)
	) {
		warnings.push('fixture checksums differ between runs; pixel changes may be fixture data, not code');
	}

	const baseKeys = imageKeys(base.dir);
	const headKeys = imageKeys(head.dir);
	const filter = request.scene;
	const keys = [...new Set([...baseKeys, ...headKeys])]
		.filter((key) => filter === undefined || key.startsWith(`${filter}.`))
		.sort();
	if (keys.length === 0) {
		throw new CompareError(
			filter === undefined ? 'no captures found on either side' : `no captures for scene "${filter}"`
		);
	}

	const compareName = `${safeName(base.label)}..${safeName(head.label)}`;
	const outDir = join(COMPARE_DIR, compareName);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(join(outDir, 'images'), { recursive: true });
	mkdirSync(join(outDir, 'diff'), { recursive: true });

	const missingFloor: string[] = [];
	const entries: SceneComparison[] = [];
	for (const id of keys) {
		const dot = id.lastIndexOf('.');
		const scene = id.slice(0, dot);
		const theme = id.slice(dot + 1) as Theme;
		const floor = noise.floor[id];
		if (floor === undefined) missingFloor.push(id);
		const images: SceneComparison['images'] = { base: null, head: null, diff: null };
		if (existsSync(join(base.dir, `${id}.png`))) {
			copyFileSync(join(base.dir, `${id}.png`), join(outDir, 'images', `${id}.base.png`));
			images.base = `images/${id}.base.png`;
		}
		if (existsSync(join(head.dir, `${id}.png`))) {
			copyFileSync(join(head.dir, `${id}.png`), join(outDir, 'images', `${id}.head.png`));
			images.head = `images/${id}.head.png`;
		}
		const compared = compareOne(id, base.dir, head.dir, floor?.maxPixels ?? 0, theme, scene, images);
		const entry = compared.entry;
		if (compared.diffImage !== null && entry.images.diff !== null) {
			writeFileSync(join(outDir, entry.images.diff), compared.diffImage);
		}
		if (entry.stableBase === false || entry.stableHead === false) {
			warnings.push(`${id}: capture did not reach a stable frame (pixel verdict is noisy)`);
		}
		entries.push(entry);
	}
	if (missingFloor.length > 0) {
		const shown = missingFloor.slice(0, 3).join(', ');
		const rest = missingFloor.length - 3;
		warnings.push(
			`no noise floor entry for ${missingFloor.length} capture(s) ` +
				`(${shown}${rest > 0 ? `, +${rest}` : ''}); compared against 0 px`
		);
	}

	const score: Score = {
		changedScenes: entries.filter((entry) => entry.verdict !== 'unchanged').length,
		changedPixels: entries.reduce(
			(sum, entry) => (entry.verdict === 'unchanged' ? sum : sum + entry.pixels),
			0
		),
		addedTextLines: entries.reduce((sum, entry) => sum + entry.textAdded.length, 0),
		removedTextLines: entries.reduce((sum, entry) => sum + entry.textRemoved.length, 0),
		newErrors: entries.reduce(
			(sum, entry) =>
				sum +
				entry.newPageErrors.length +
				entry.newConsoleErrors.length +
				entry.newFailedRequests.length +
				entry.newMissingText.length +
				(entry.newSceneError === null ? 0 : 1),
			0
		)
	};
	const changed = entries.some((entry) => entry.verdict !== 'unchanged' || entry.factsChanged);
	const result: CompareResult = {
		base,
		head,
		dir: outDir,
		noise: { file: noise.file, checksum: noise.checksum, entries: Object.keys(noise.floor).length },
		warnings,
		entries,
		score,
		verdict: changed ? 'changed' : 'unchanged'
	};
	const summary = buildSummary(result);
	writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary)}\n`);
	writeFileSync(join(outDir, 'full.json'), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(outDir, 'index.html'), renderCompareReport(result));
	return { ...result, summary };
}

function summarizeEntry(entry: SceneComparison): SummaryEntry {
	const summary: SummaryEntry = {
		id: entry.id,
		verdict: entry.verdict,
		pixels: entry.pixels,
		ratio: Number(entry.ratio.toFixed(6))
	};
	if (entry.bounds !== null) summary.bounds = entry.bounds;
	if (entry.textAdded.length > 0 || entry.textRemoved.length > 0) {
		summary.text = { added: entry.textAdded.length, removed: entry.textRemoved.length };
	}
	const errors = {
		page: entry.newPageErrors.length,
		console: entry.newConsoleErrors.length,
		failed: entry.newFailedRequests.length,
		missing: entry.newMissingText.length,
		scene: entry.newSceneError === null ? 0 : 1
	};
	if (Object.values(errors).some((count) => count > 0)) summary.errors = errors;
	if (entry.factsChanged) summary.factsChanged = true;
	return summary;
}

/** summary.json is the default stdout, so it stays small enough to paste into
 * a loop log: unchanged entries are dropped first, then bounds/ratios. */
function buildSummary(result: CompareResult): Summary {
	const baseBrowser = result.base.meta?.chromium ?? null;
	const headBrowser = result.head.meta?.chromium ?? null;
	const summary: Summary = {
		base: {
			label: result.base.label,
			sha: result.base.meta?.sourceSha ?? result.base.meta?.lens.sha ?? null,
			browser: baseBrowser
		},
		head: {
			label: result.head.label,
			sha: result.head.meta?.sourceSha ?? result.head.meta?.lens.sha ?? null,
			browser: headBrowser
		},
		verdict: result.verdict,
		browsersMatch: baseBrowser !== null && baseBrowser === headBrowser,
		noise: { file: result.noise.file, entries: result.noise.entries },
		score: result.score,
		scenes: result.entries.map(summarizeEntry),
		warnings: result.warnings
	};
	if (Buffer.byteLength(JSON.stringify(summary)) <= 2048) return summary;

	const moved = result.entries.filter((entry) => entry.verdict !== 'unchanged' || entry.factsChanged);
	summary.scenes = moved.map((entry) => {
		const compact = summarizeEntry(entry);
		delete compact.bounds;
		delete compact.ratio;
		return compact;
	});
	summary.unchangedCount = result.entries.length - moved.length;
	// Still too big: drop entries from the tail. The score keeps the totals and
	// full.json has everything, so the 2 KB promise holds for any scene count.
	while (Buffer.byteLength(JSON.stringify(summary)) > 2048 && summary.scenes.length > 0) {
		summary.scenes.pop();
		summary.omittedEntries = (summary.omittedEntries ?? 0) + 1;
	}
	return summary;
}
