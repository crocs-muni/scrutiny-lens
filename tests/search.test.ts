// Local search seam (issue #27; engine choice decided on #12 — FlexSearch,
// MiniSearch stays one import away). Ranked, typo-tolerant id matches over
// the cached events; deterministic filtering stays out of the engine.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSearchEngine, indexEvent, searchText } from '../src/lib/search';
import { _closeForTests, clearAllLocalData, getEvent, initPersistence, registerSecret } from '$lib/db';
import type { NostrEvent } from '$lib/fabric';
const SECRET = 'sk-testsecret-1234567890';

function event(id: string, content: string, ttags: string[] = []): NostrEvent {
	return {
		id,
		sig: 'ab'.repeat(64),
		pubkey: 'cd'.repeat(32),
		created_at: 1000,
		kind: 1,
		tags: ttags.map((t) => ['t', t]),
		content
	};
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
});

afterEach(() => {
	resetSearchEngine();
	_closeForTests();
});

describe('searchText (spec §3; #12 engine ruling)', () => {
	it('matches exact terms and returns ids', async () => {
		await indexEvent(event('e1', 'ROCA vulnerability in Infineon TPM chips'));
		await indexEvent(event('e2', 'Common Criteria certificate for NXP JCOP4'));
		expect(await searchText('vulnerability')).toEqual(['e1']);
	});

	it('is typo-tolerant (tolerant tokenizer: transpositions, dropped letters)', async () => {
		await indexEvent(event('e1', 'ROCA vulnerability in Infineon TPM chips'));
		expect(await searchText('vunerability')).toEqual(['e1']);
		await indexEvent(event('e2', 'Common Criteria certificate for NXP JCOP4'));
		await indexEvent(event('e3', 'FIPS 140-3 module firmware note'));
		expect(await searchText('certifcate')).toEqual(['e2']);
	});

	it('matches identifiers carried in t-tags, not only content', async () => {
		await indexEvent(
			event('e1', 'TPM bug mentioned in passing', ['scrutiny-product', 'cve-2017-15361'])
		);
		expect(await searchText('cve-2017-15361')).toEqual(['e1']);
	});

	it('returns a ranked list when several events match', async () => {
		await indexEvent(event('e1', 'Infineon TPM: ROCA vulnerability in Infineon chips'));
		await indexEvent(event('e2', 'mentions Infineon briefly'));
		const hits = await searchText('infineon');
		expect(hits).toContain('e1');
		expect(hits).toContain('e2');
		expect(hits[0]).toBe('e1'); // denser occurrence ranks first
	});

	it('re-indexing an id never duplicates its matches', async () => {
		await indexEvent(event('e1', 'ROCA vulnerability'));
		await indexEvent(event('e1', 'ROCA vulnerability revised'));
		expect((await searchText('ROCA')).filter((id) => id === 'e1')).toHaveLength(1);
	});

	it('an empty corpus yields no matches, never an error', async () => {
		expect(await searchText('anything')).toEqual([]);
	});

	it('honors the limit', async () => {
		for (let i = 0; i < 10; i++) await indexEvent(event(`e${i}`, 'shared term here'));
		expect((await searchText('shared', 3)).length).toBe(3);
	});
});

describe('write-through invariants (review round)', () => {
	it('indexes the redacted row, never the raw event (spec §6)', async () => {
		await initPersistence();
		registerSecret(SECRET);
		await indexEvent(event('e1', `leaked payload ${SECRET} inside content`, ['t-a']));
		// The in-memory engine must hold the same redacted text the store does —
		// or session hits and post-reload hits diverge.
		const stored = await getEvent('e1');
		expect(stored?.content).not.toContain(SECRET);
		expect(await searchText(SECRET)).toEqual([]);
		expect(await searchText('leaked')).toEqual(['e1']);
		await clearAllLocalData();
		_closeForTests();
	});

	it('a skipped cache write is never indexed (quota degrade)', async () => {
		_closeForTests();
		await indexEvent(event('e1', 'ghost event content'));
		expect(await searchText('ghost')).toEqual([]);
	});
});
