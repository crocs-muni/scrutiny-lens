// Relay-truth conformance (issue #131): the rework's invariants, asserted
// statically so the next contributor cannot quietly reintroduce a live
// `settings.relays` read into the I/O layers. The bug class this guards
// against: a display or fetch leg reading live settings while the run owns
// a frozen pool — the "trace says 4 relays, network asked something else"
// desync from the 2026-10-19 review.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src', 'lib');


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

describe('relay truth conformance (issue #131)', () => {
	it('no I/O layer reads the settings singleton for relays', () => {
		// The I/O layers (net/, pipeline/) may not import the settings
		// singleton EXCEPT two sanctioned sites: profiles.ts's dynamic import
		// (spec §9 — components never hard-import settings; the seam snapshots
		// at call time) and share-open.ts's configured-pool leg (the cold open
		// IS a live-at-entry snapshot by design, spec §8). A new import
		// elsewhere is exactly how the live-read desync crept back in.
		const sanctioned = ['net\\profiles.ts', 'pipeline\\share-open.ts'];
		const offenders = ioFiles.filter(
			(file) =>
				!file.endsWith('investigation.svelte.ts') &&
				!sanctioned.some((s) => file.endsWith(s)) &&
				/settings(\.svelte)?['"]/.test(readFileSync(file, 'utf8'))
		);
		expect(
			offenders.map((f) => f.replace(SRC, '')),
			'pass the relay pool as a parameter instead of reading settings'
		).toEqual([]);
	});

	it('investigation reads settings.relays exactly at the two snapshot sites', () => {
		const source = readFileSync(join(SRC, 'investigation.svelte.ts'), 'utf8');
		const occurrences = source.match(/settings\.relays/g) ?? [];
		// start()'s frozen capture + openShared()'s live-at-entry capture.
		// restore() reads the run record, never settings. This count going UP
		// means a leg re-read live state — the original bug.
		expect(occurrences.length, 'each new settings.relays read in investigation is a desync bug').toBe(2);
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
});
