// Trace derivation contract (issue #36, spec §2.1 rule 6): the three rows
// and every counter come from real pipeline state — the mapping is the
// honesty surface, so its boundaries are pinned here: translate → fetch →
// done transitions, arithmetic over slices, amber cells only for honesty
// events, the decouple fill that may lag phase 'done', and the error
// settlement that never leaves a row spinning.
//
// Run scoping (issue #131): every counter and tick describes THIS run —
// the frozen pool it was given, never a live Settings read — and the
// literal layer folds to one line per relay (#132).

import { describe, expect, it } from 'vitest';
import { derivePhaseRows, doneLine, type TraceInput } from '$lib/trace';
import { aggregatePerRelay } from '$lib/relay-readout';

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
		expect(running[0].label).toBe('Translating query');

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

	it('a restored run names the cache instead of lying "0 of N answered" (issue #83, spec §2 rule 6)', () => {
		// The relays were never asked — the whole frontier arrived from the
		// cache, so "0 of 3 answered" would pretend the run queried and came
		// up empty. The done line still counts the cache leg as its source,
		// exactly like a live run's cache slice.
		const restored: TraceInput = {
			...base,
			phase: 'done',
			slices: [{ url: 'local-cache', received: 2, route: 'cache', rejected: 0, status: 'ok' }],
			skeletons: [{ typeTag: 'scrutiny-product' }, { typeTag: 'scrutiny-metadata' }]
		};
		const rows = derivePhaseRows(restored);
		expect(rows[1].counter).toBe('restored from local cache');
		expect(doneLine(restored)).toBe('Done. 1 product · 1 metadata · 1 source');
	});

	it('a LIVE cache-assisted run with all relays refused keeps its true "0 of N answered"', () => {
		// Guard for the every() condition: the cache leg + a refused relay leg
		// is a live run that asked and failed — NOT a restore. Only an
		// all-cache slice list must ever read "restored from local cache".
		const liveRefused: TraceInput = {
			...base,
			phase: 'done',
			relayCount: 2,
			slices: [
				{ url: 'local-cache', received: 4, route: 'cache', rejected: 0, status: 'ok' },
				{ url: 'wss://a', received: 0, route: 'tag:x', rejected: 0, status: 'refused' }
			]
		};
		const rows = derivePhaseRows(liveRefused);
		expect(rows[1].counter).toBe('0 of 2 answered');
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

	it('a notice duplicated in the input renders once in the row (each_key_duplicate guard)', () => {
		// §4 translate-fallback: the same degraded message can reach the run
		// twice (incremental emit + final flush). PhaseRow keys ticks by text,
		// so a repeat would throw each_key_duplicate; the row dedupes, keeping
		// the first occurrence in place.
		const msg = 'AI translate degraded (schema_failure) — falling back to a plain-text search of your words';
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			slices: [{ url: 'wss://a', received: 2, route: 'text:x', rejected: 0, status: 'ok' }],
			notices: [
				{ kind: 'capability', message: msg },
				{ kind: 'capability', message: msg }
			]
		});
		const texts = rows[1].ticks.map((t) => t.text);
		expect(texts.filter((t) => t === msg)).toHaveLength(1);
		// first occurrence is kept, slice receipt untouched and ordered before it
		expect(texts[0]).toContain('records');
		expect(texts[1]).toBe(msg);
		expect(texts).toHaveLength(2);
	});
});

describe('decouple row — no fill attempt (spec §2.1 rule 6)', () => {
	it('completes with an honest raw counter at done, never fabricated (#108 vocabulary)', () => {
		const rows = derivePhaseRows({ ...base, phase: 'done' });
		expect(rows[2].status).toBe('completed');
		expect(rows[2].label).toBe('Decoupling and filling the cards');
		expect(rows[2].counter).toBe('admitted 0 · raw');
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
		expect(rows[2].counter).toBe('admitted 0 · 2 of 9 filled');
		expect(rows[2].progress).toBe(2 / 9);
	});

	it('settled fill reports the real tally, partial or not', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			descriptions: { running: false, interpreted: 7, total: 9 }
		});
		expect(rows[2].status).toBe('completed');
		expect(rows[2].counter).toBe('admitted 0 · 7 of 9 filled');
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
		expect(rows[2].counter).toBe('admitted 0 · 2 of 9 filled');
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

describe("run-scoped display (issue #131: the run's truth, not live Settings)", () => {
	it("the sources counter renders the run's passed relayCount verbatim", () => {
		// The pool count is whatever THIS run froze — 5 here even though only
		// 1 relay answered; the counter is the run's own receipt.
		const rows = derivePhaseRows({
			...base,
			phase: 'fetch',
			relayCount: 5,
			slices: [
				{ url: 'wss://a', received: 3, route: 'tag:x', rejected: 0, status: 'ok' },
				{ url: 'wss://b', received: 0, route: 'text:y', rejected: 0, status: 'timeout' }
			]
		});
		expect(rows[1].counter).toBe('1 of 5 answered');
	});

	it('a restored run with a recorded pool keeps the cache counter and appends the recorded-pool tick', () => {
		// The run's record names 3 relays, the restore asked none of them
		// again — the counter stays "restored from local cache" (issue #83,
		// derived from the all-cache slices alone: runKind has no 'restore'
		// arm to set) and one appended tick states the recorded pool instead
		// of implying the cache leg was the whole relay set.
		const restored: TraceInput = {
			...base,
			phase: 'done',
			relayCount: 3,
			slices: [{ url: 'local-cache', received: 2, route: 'cache', rejected: 0, status: 'ok' }],
			skeletons: [{ typeTag: 'scrutiny-product' }]
		};
		const rows = derivePhaseRows(restored);
		expect(rows[1].counter).toBe('restored from local cache');
		// cache leg first (arrival order), then the appended record tick
		expect(rows[1].ticks[0].text).toBe('cache local cache → 2 records');
		expect(rows[1].ticks).toContainEqual({ text: 'relay set as recorded - 3 relays' });

		// A legacy row without the field records nothing (relayCount 0): no
		// counter and no invented "N relays" tick — unknown is not zero, and
		// the row SAYS it was not recorded rather than staying silent while
		// its context legs query today's pool (spec §2 rule 6).
		const legacy = derivePhaseRows({ ...restored, relayCount: 0 });
		expect(legacy[1].counter).toBe('');
		expect(legacy[1].ticks.map((t) => t.text)).toEqual([
			'cache local cache → 2 records',
			'relay set not recorded - context queries today\u2019s pool'
		]);
	});

	it('a share cold-open names the link instead of "0 of N answered"', () => {
		// openShared adopted an already-fetched root — no query happened, so
		// the sources row must not report a relay tally at all (spec §2 rule 6).
		const share: TraceInput = { ...base, phase: 'done', runKind: 'share', relayCount: 4 };
		expect(derivePhaseRows(share)[1].counter).toBe('opened from share link');

		// runKind is what carries the copy: the same done state as a SEARCH
		// run still reports the honest asking tally.
		const search = derivePhaseRows({ ...share, runKind: 'search' });
		expect(search[1].counter).toBe('0 of 4 answered');
	});

	it("3 routes × 4 relays of legs fold into exactly 4 relay lines (#132's root check)", () => {
		const slices: TraceInput['slices'] = [
			{ url: 'local-cache', received: 4, route: 'cache', rejected: 0, status: 'ok' }
		];
		for (const host of ['a', 'b', 'c', 'd']) {
			for (const route of ['tag:cve:x', 'text:foo', 'text:bar']) {
				slices.push({ url: `wss://${host}.example`, route, received: 2, rejected: 0, status: 'ok' });
			}
		}
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			relayCount: 4,
			slices,
			relayLines: aggregatePerRelay(slices)
		});
		const relayTicks = rows[1].ticks.filter((t) => / - \d+ routes? - /.test(t.text));
		expect(relayTicks).toHaveLength(4);
		expect(relayTicks[0].text).toBe('a.example - 3 routes - 6 records');
		expect(relayTicks[0].warn).toBe(false);
		// the cache leg has no receipt, so it keeps its own visible tick
		expect(rows[1].ticks.at(-1)?.text).toBe('cache local cache → 4 records');
		expect(rows[1].ticks).toHaveLength(5);
	});

	it('two distinct relays on one host stay two ticks (tick identity is the text)', () => {
		// Same host, different mount paths, identical counts. A host-only
		// label produced the same string twice, so the row's text-dedupe (the
		// each_key_duplicate guard) swallowed the second relay and the trace
		// under-reported the run's sources. The path is part of the label, and
		// 'route' pluralizes.
		const slices: TraceInput['slices'] = [
			{ url: 'wss://relay.example/a', received: 3, route: 'tag:cve:x', rejected: 0, status: 'ok' },
			{ url: 'wss://relay.example/b', received: 3, route: 'tag:cve:x', rejected: 0, status: 'ok' }
		];
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			relayCount: 2,
			slices,
			relayLines: aggregatePerRelay(slices)
		});
		expect(rows[1].ticks.map((t) => t.text)).toEqual([
			'relay.example/a - 1 route - 3 records',
			'relay.example/b - 1 route - 3 records'
		]);
		expect(rows[1].counter).toBe('2 of 2 answered');
	});

	it('a refused relay appears once, its status verbatim', () => {
		// Two legs against nos.lol, both refused: one folded line, one amber
		// cell, the word "refused" carried through unsmoothed (spec §3/§4).
		const slices: TraceInput['slices'] = [
			{ url: 'wss://damus.io', received: 11, route: 'tag:cve:x', rejected: 0, status: 'ok' },
			{ url: 'wss://nos.lol', received: 0, route: 'tag:cve:x', rejected: 0, status: 'refused' },
			{ url: 'wss://nos.lol', received: 0, route: 'text:foo', rejected: 0, status: 'refused' }
		];
		const rows = derivePhaseRows({
			...base,
			phase: 'done',
			slices,
			relayLines: aggregatePerRelay(slices)
		});
		const nos = rows[1].ticks.filter((t) => t.text.includes('nos.lol'));
		expect(nos).toHaveLength(1);
		expect(nos[0]).toEqual({ text: 'relay nos.lol refused', warn: true });
	});
});
