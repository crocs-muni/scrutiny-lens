// Trace derivation contract (issue #36, spec §2 rule 6): the five rows and
// every counter come from real pipeline state — the mapping is the honesty
// surface, so its boundaries are pinned here: translate → fetch → done
// transitions, arithmetic over slices, amber cells only for honesty events,
// and the descriptions row that must never claim "written" before #38.

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
		expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
		expect(rows[0].counter).toBe('');
	});

	it('question row runs during translate, completes with the searches as counter', () => {
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
			{ url: 'local-cache', received: 4, route: 'cache', rejected: 0 },
			{ url: 'wss://relay.damus.io', received: 11, route: 'tag:cve:CVE-2017-15361', rejected: 1 },
			{ url: 'wss://nos.lol', received: 5, route: 'text:vendor infineon:fullscan', rejected: 0 }
		],
		skeletons: Array.from({ length: 19 }, () => ({}))
	};

	it('sources counts distinct answering relays, excluding the cache leg', () => {
		const rows = derivePhaseRows(slicing);
		expect(rows[1].counter).toBe('2 of 3 answered');
	});

	it('records sums received, organize counts admitted/rejected live', () => {
		const rows = derivePhaseRows(slicing);
		expect(rows[2].counter).toBe('20 so far');
		expect(rows[3].counter).toBe('admitted 19 · rejected 1');
	});
});

describe('derivePhaseRows — honesty cells', () => {
	it('fullscan legs render as amber ticks; plain legs do not', () => {
		const rows = derivePhaseRows({
			...base,
			phase: 'fetch',
			slices: [
				{ url: 'wss://relay.damus.io', received: 11, route: 'tag:cve:x', rejected: 0 },
				{ url: 'wss://nos.lol', received: 5, route: 'text:vendor infineon:fullscan', rejected: 0 }
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
			slices: [{ url: 'local-cache', received: 4, route: 'cache', rejected: 0 }],
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

describe('descriptions row (spec §2 rule 5)', () => {
	it('is skipped with honest counter at done, never claims written', () => {
		const rows = derivePhaseRows({ ...base, phase: 'done' });
		expect(rows[4].status).toBe('skipped');
		expect(rows[4].counter).toBe('not interpreted');
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
				{ url: 'local-cache', received: 4, route: 'cache', rejected: 0 },
				{ url: 'wss://a', received: 11, route: 'tag:x', rejected: 0 },
				{ url: 'wss://b', received: 5, route: 'tag:x', rejected: 0 }
			]
		});
		expect(line).toBe('Done. 2 products · 1 metadata · 3 sources');
	});

	it('hides the plural on singletons', () => {
		const line = doneLine({
			...base,
			phase: 'done',
			skeletons: [{ typeTag: 'scrutiny-product' }],
			slices: [{ url: 'wss://a', received: 1, route: 'tag:x', rejected: 0 }]
		});
		expect(line).toBe('Done. 1 product · 0 metadata · 1 source');
	});

	it('zero-product runs name only real counts', () => {
		const line = doneLine({
			...base,
			phase: 'done',
			skeletons: [{ typeTag: 'scrutiny-metadata' }],
			slices: [{ url: 'wss://a', received: 1, route: 'tag:x', rejected: 0 }]
		});
		expect(line).toBe('Done. 0 products · 1 metadata · 1 source');
	});
});
