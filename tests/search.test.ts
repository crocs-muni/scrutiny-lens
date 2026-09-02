// Local search seam (issue #27; engine choice decided on #12 — FlexSearch,
// MiniSearch stays one import away). Ranked, typo-tolerant id matches over
// the cached events; deterministic filtering stays out of the engine.

import { afterEach, describe, expect, it } from 'vitest';
import { resetSearchEngine, indexEvent, searchText } from '../src/lib/search';
import type { NostrEvent } from '$lib/fabric';

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

afterEach(() => {
	resetSearchEngine();
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
