// Trace derivation contract (issue #36, spec §2.1 rule 6): the three rows
// and every counter come from real pipeline state — the mapping is the
// honesty surface, so its boundaries are pinned here: translate → fetch →
// done transitions, arithmetic over slices, amber cells only for honesty
// events, the decouple fill that may lag phase 'done', and the error
// settlement that never leaves a row spinning.

import { describe, expect, it } from 'vitest';
import { derivePhaseRows, doneLine, type TraceInput } from '$lib/trace';

const base: TraceInput = {
	phase: 'idle',
	searches: [],
	slices: [],
	skeletons: [],
	notices: [],
	relayCount: 3,
	error: null
};

describe('derivePhaseRows — phase transitions', () => {
	it('all rows pending before anything starts', () => {
		const rows = derivePhaseRows(base);
		expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
		expect(rows[0].counter).toBe('');
	});

	it('interpret row runs during translate, completes with the searches as counter', () => {
		const running = derivePhaseRows({ ...base, phase: 'translate' });
		expect(running[0].status).toBe('running');

		const translated = derivePhaseRows({
			...base,
			phase: 'fetch',
			searches: [
				{ kind: 'tag', value: 'cve:CVE-2017-15361', source: 'identifier' },
				{ kind: 'text', value: 'vendor infineon', source: 'ai' }
			]
		});
		expect(translated[0].status).toBe('completed');
		expect(translated[0].counter).toBe('cve:CVE-2017-15361 · vendor infineon');
	});
});

describe('derivePhaseRows — counters are arithmetic over slices', () => {
	const slicing: TraceInput = {
		...base,
		phase: 'fetch',
		slices: [
			{ url: 'local-cache', received: 4, route: 'cache', rejected: 0, status: 'ok' },
			{ url: 'wss://relay.damus.io', received: 11, route: 'tag:cve:CVE-2017-15361', rejected: 1, status: 'ok' },
			{ url: 'wss://nos.lol', received: 5, route: 'text:vendor infineon:fullscan', rejected: 0, status: 'ok' }
		],
		skeletons: Array.from({ length: 19 }, () => ({}))
	};

	it('sources counts distinct answering relays, excluding the cache leg', () => {
		const rows = derivePhaseRows(slicing);
		expect(rows[1].counter).toBe('2 of 3 answered');
	});
	it('refused relays count neither as answered nor as sources, and tick amber (spec §3/§4: dead relay ≠ no matches)', () => {
		const refused: TraceInput = {
			...base,
			phase: 'done',
			slices: [
				{ url: 'wss://relay.damus.io', received: 11, route: 'tag:cve:x', rejected: 0, status: 'ok' },
				{ url: 'wss://nos.lol', received: 0, route: 'tag:cve:x', rejected: 0, status: 'refused' }
			]
		};
		const rows = derivePhaseRows(refused);
		expect(rows[1].counter).toBe('1 of 3 answered');
		expect(doneLine({ ...refused, skeletons: [] })).toBe('Done. 0 products · 0 metadata · 1 source');
		const refusedTick = rows[1].ticks.find((t) => t.text.includes('nos.lol'));
		expect(refusedTick?.warn).toBe(true);
		expect(refusedTick?.text).toContain('refused');
	});

	it('decouple admits/rejects live, and receipts the raw-event total once', () => {
		const rows = derivePhaseRows(slicing);
		expect(rows[2].status).toBe('running');
		expect(rows[2].counter).toBe('admitted 19 · rejected 1');
		expect(rows[2].ticks[0].text).toBe('decoupled 20 raw events → 19 admitted · 1 rejected');
	});

	it('de-dupe is NOT a rejection: received exceeding admitted with zero slice rejects shows rejected 0 (spec §2 rule 6)', () => {
		const dedupe: TraceInput = {
			...slicing,
			// 30 raw events across slices (some relays re-serve the same
			// event), but only 29 unique events admitted — and no admission
			// reject at any leg.
			slices: [
				{ url: 'wss://a', received: 20, route: 'tag:cve:x', rejected: 0, status: 'ok' },
				{ url: 'wss://b', received: 10, route: 'tag:cve:x', rejected: 0, status: 'ok' }
			],
			skeletons: Array.from({ length: 29 }, () => ({ typeTag: 'scrutiny-product' }))
		};
		const rows = derivePhaseRows(dedupe);
		expect(rows[2].ticks[0].text).toBe('decoupled 30 raw events → 29 admitted · 0 rejected');
	});
});

describe('derivePhaseRows — honesty cells', () => {
	it('fullscan legs render as amber ticks; plain legs do not', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'fetch',
			slices: [
				{ url: 'wss://relay.damus.io', received: 11, route: 'tag:cve:x', rejected: 0, status: 'ok' },
				{ url: 'wss://nos.lol', received: 5, route: 'text:vendor infineon:fullscan', rejected: 0, status: 'ok' }
			]
		});
		const ticks = rows[1].ticks;
		expect(ticks[0].warn).toBe(false);
		expect(ticks[1].warn).toBe(true);
		expect(ticks[0].text).toContain('relay.damus.io');
	});

	it('capability and truncation notices are amber ticks; cache notice is neutral', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			slices: [{ url: 'local-cache', received: 4, route: 'cache', rejected: 0, status: 'ok' }],
			notices: [
				{ kind: 'cache', message: '4 from local cache' },
				{ kind: 'capability', message: 'relay x lacks search support — falling back to a tag scan' }
			]
		});
		const ticks = rows[1].ticks;
		expect(ticks.find((t) => t.text.includes('local cache'))?.warn).toBe(false);
		expect(ticks.find((t) => t.text.includes('lacks search'))?.warn).toBe(true);
	});
});

describe('decouple row — no fill attempt (spec §2.1 rule 6)', () => {
	it('completes with an honest not-interpreted counter at done, never fabricated', () => {
		const rows = derivePhaseRows({ ...base, phase: 'done' });
		expect(rows[2].status).toBe('completed');
		expect(rows[2].counter).toBe('admitted 0 · not interpreted');
		expect(rows[2].progress).toBeNull();
	});
});

describe('decouple row — descriptions fill (spec §7)', () => {
	it('running fill shows live progress, never a fabricated completion', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'fetch',
			descriptions: { running: true, interpreted: 2, total: 9 }
		});
		expect(rows[2].status).toBe('running');
		expect(rows[2].counter).toBe('admitted 0 · 2 of 9 interpreted');
		expect(rows[2].progress).toBe(2 / 9);
	});

	it('settled fill reports the real tally, partial or not', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			descriptions: { running: false, interpreted: 7, total: 9 }
		});
		expect(rows[2].status).toBe('completed');
		expect(rows[2].counter).toBe('admitted 0 · 7 of 9 interpreted');
		expect(rows[2].progress).toBeNull();
	});

	it('a done phase with a still-running fill stays running (lag guard)', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			descriptions: { running: true, interpreted: 2, total: 9 },
			slices: [{ url: 'wss://a', received: 3, route: 'tag:x', rejected: 0, status: 'ok' }]
		});
		expect(rows[2].status).toBe('running');
		expect(rows[2].counter).toBe('admitted 0 · 2 of 9 interpreted');
		expect(rows[2].progress).toBe(2 / 9);
	});
});

describe('error settlement (spec §2.1 rule 6)', () => {
	it('an errored run settles: no row spinning, the running row fails', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'fetch',
			slices: [{ url: 'wss://a', received: 3, route: 'tag:x', rejected: 0, status: 'ok' }],
			error: 'transport needs at least one relay url'
		});
		expect(rows.some((r) => r.status === 'running')).toBe(false);
		// Completed rows keep 'completed'; the row that was running fails.
		expect(rows[0].status).toBe('completed');
		expect(rows[1].status).toBe('skipped');
		expect(rows[2].status).toBe('failed');
	});

	it('errored during translate: the interpret row fails, not running', () => {
		const rows = derivePhaseRows({ ...base, phase: 'translate', error: 'AI unreachable' });
		expect(rows[0].status).toBe('failed');
		expect(rows.some((r) => r.status === 'running')).toBe(false);
	});
});

describe('doneLine', () => {
	it('counts products and distinct sources incl. cache leg', () => {
		const line = doneLine({
			...base,
			phase: 'done',
			skeletons: [
				{ typeTag: 'scrutiny-product' },
				{ typeTag: 'scrutiny-product' },
				{ typeTag: 'scrutiny-metadata' }
			],
			slices: [
				{ url: 'local-cache', received: 4, route: 'cache', rejected: 0, status: 'ok' },
				{ url: 'wss://a', received: 11, route: 'tag:x', rejected: 0, status: 'ok' },
				{ url: 'wss://b', received: 5, route: 'tag:x', rejected: 0, status: 'ok' }
			]
		});
		expect(line).toBe('Done. 2 products · 1 metadata · 3 sources');
	});

	it('hides the plural on singletons', () => {
		const line = doneLine({
			...base,
			phase: 'done',
			skeletons: [{ typeTag: 'scrutiny-product' }],
			slices: [{ url: 'wss://a', received: 1, route: 'tag:x', rejected: 0, status: 'ok' }]
		});
		expect(line).toBe('Done. 1 product · 0 metadata · 1 source');
	});

	it('zero-product runs name only real counts', () => {
		const line = doneLine({
			...base,
			phase: 'done',
			skeletons: [{ typeTag: 'scrutiny-metadata' }],
			slices: [{ url: 'wss://a', received: 1, route: 'tag:x', rejected: 0, status: 'ok' }]
		});
		expect(line).toBe('Done. 0 products · 1 metadata · 1 source');
	});
});
