// Relay-truth conformance (issue #131): the rework's invariants, asserted
// statically so the next contributor cannot quietly reintroduce a live
// `settings.relays` read into the I/O layers. The bug class this guards
// against: a display or fetch leg reading live settings while the run owns
// a frozen pool — the "trace says 4 relays, network asked something else"
// desync from the 2026-10-19 review.
//
// Portability (review finding 10/22, P0): every path assertion compares
// POSIX-normalized relative paths. The sanctioned list is written
// 'net/profiles.ts', while win32's readdir hands back 'net\\profiles.ts' —
// an endsWith() against the raw path silently disabled this whole scan on
// Windows, the platform the reviewers ran.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src', 'lib');

/** Path under src/lib, POSIX-separated — the only form any assertion uses. */
const rel = (file: string): string => relative(SRC, file).split(sep).join('/');

/** Every file under src/lib/net and src/lib/pipeline, plus investigation. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|svelte)$/.test(entry)) out.push(full);
	}
	return out;
}

const ioFiles = [
	...walk(join(SRC, 'net')),
	...walk(join(SRC, 'pipeline')),
	join(SRC, 'investigation.svelte.ts')
];

describe('conformance harness portability', () => {
	it('compares paths in POSIX form on every platform', () => {
		// The self-check the first version lacked: on win32 `relative()` returns
		// 'net\\profiles.ts', which no POSIX sanctioned entry can match — the
		// scan below would then complain about nothing being sanctioned and the
		// offenders filter would never fire.
		expect(rel(join(SRC, 'net', 'profiles.ts'))).toBe('net/profiles.ts');
		expect(rel(join(SRC, 'pipeline', 'share-open.ts'))).toBe('pipeline/share-open.ts');
		expect(walk(join(SRC, 'net')).every((file) => !rel(file).includes('\\'))).toBe(true);
	});
});

describe('relay truth conformance (issue #131)', () => {
	it('no I/O layer reads the settings singleton for relays', () => {
		// The I/O layers (net/, pipeline/) may not import the settings
		// singleton EXCEPT two sanctioned sites: profiles.ts's dynamic import
		// (spec §9 — components never hard-import settings; the seam snapshots
		// at call time) and share-open.ts's configured-pool leg (the cold open
		// IS a live-at-entry snapshot by design, spec §8). A new import
		// elsewhere is exactly how the live-read desync crept back in.
		const sanctioned = ['net/profiles.ts', 'pipeline/share-open.ts'];
		const offenders = ioFiles.filter(
			(file) =>
				rel(file) !== 'investigation.svelte.ts' &&
				!sanctioned.includes(rel(file)) &&
				/settings(\.svelte)?['"]/.test(readFileSync(file, 'utf8'))
		);
		expect(
			offenders.map(rel),
			'pass the relay pool as a parameter instead of reading settings'
		).toEqual([]);
	});

	it('every transport in investigation carries a run snapshot, never live settings', () => {
		// Structural guard (replaces the old `settings.relays` occurrence
		// count, which only ever failed on a literal edit and said nothing
		// about WHERE a pool came from): each createTransport call site must
		// feed the transport a COPY of one of the run's snapshots — start()'s
		// frozen local `pool` (Object.freeze([...settings.relays]) taken
		// before the first leg), admitContext()'s context leg pool, or
		// `this.runRelays` — and never a live settings read, which is the
		// desync verbatim.
		const runsSnapshot = new RegExp(
			['this.runRelays', 'pool', 'legPool', 'this.contextLegPool()']
				.map((local) => `\\[\\.\\.\\.(?:${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\]`)
				.join('|')
		);
		const source = readFileSync(join(SRC, 'investigation.svelte.ts'), 'utf8');
		const calls = [...source.matchAll(/createTransport\(\s*\{\s*urls:/g)];
		expect(calls.length, 'the guard must actually find the call sites').toBeGreaterThan(0);
		for (const call of calls) {
			const at = call.index ?? 0;
			const window = source.slice(at, at + 120);
			const line = window.split(/\r?\n/)[0];
			expect(line, `a transport fed from live settings is the #131 desync: ${line}`).not.toContain(
				'settings'
			);
			expect(window, `the transport must carry a frozen run snapshot: ${line}`).toMatch(
				runsSnapshot
			);
		}
	});

	it('TaskTrace renders the run, not settings', () => {
		const source = readFileSync(join(SRC, 'components/ui/TaskTrace.svelte'), 'utf8');
		expect(source, 'the trace counter must read investigation.runRelays').toContain(
			'investigation.runRelays'
		);
		expect(source).not.toContain('settings.relays');
	});

	it('the results surface renders the run, not settings', () => {
		const source = readFileSync(join(SRC, '..', 'routes/+page.svelte'), 'utf8');
		expect(source, 'ResultsEmpty must receive the run pool size').toContain(
			'relayCount={investigation.runRelays.length}'
		);
		expect(source).not.toContain('relayCount={settings.relays.length}');
	});

	it('the settings dialog claims nothing about automatic saving', () => {
		const source = readFileSync(join(SRC, 'components/shell/SettingsDialog.svelte'), 'utf8');
		expect(source).not.toMatch(/saved automatically/i);
	});

	it('the degrade surfaces count relays through the fold, never raw legs (issue #154)', () => {
		// Issue #132 folded the trace row; #154 found the banner, footer and
		// all-dead screen still reading per-LEG slices, so 3 dead relays asked
		// by 3 searches printed "9 relays degraded". The page-level assertions
		// below are what a revert of +page.svelte would trip.
		const source = readFileSync(join(SRC, '..', 'routes/+page.svelte'), 'utf8');
		expect(source, 'banner/footer/error screen must read the per-relay fold').toMatch(
			/const relayReceipts = \$derived\(aggregatePerRelay\(investigation\.slices\)\)/
		);
		expect(source, 'the banner text must come from the folded receipts').toContain(
			'degradedBannerText(relayReceipts)'
		);
		expect(source, 'ResultsError must receive folded receipts').toContain('relays={relayReceipts}');
		// The regression shape itself: a filter over raw slices.
		expect(source, 'no surface may filter raw slices for degraded legs').not.toMatch(
			/investigation\.slices\.filter/
		);
		expect(source, 'the footer ledger must read folded receipts').toMatch(
			/\.\.\.degradedRelays\.map\(/
		);
	});

	it('the endpoint draft holds the same pristine-rebase guard as the relay drafts', () => {
		const source = readFileSync(join(SRC, 'components/shell/SettingsDialog.svelte'), 'utf8');
		// The dialog mounts before settings.ready() can resolve and would show
		// DEFAULT_ENDPOINT; an innocent blur would then persist that default
		// over the user's real endpoint unless the draft rebases only while
		// pristine.
		expect(source).toContain('let endpointDirty = $state(false)');
		expect(source).toContain('oninput={() => (endpointDirty = true)}');
		expect(source, 'the endpoint rebase must hold a dirty draft').toMatch(
			/if \(endpointDirty\) return;[\s\S]{0,80}endpointDraft = settings\.endpoint;/
		);
	});
});
