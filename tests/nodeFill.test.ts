// Node-interpretation trickle (#29c, owner ruling C 2026-09-16): the cache
// is the fast path — a revisited graph paints sans at t≈0 with NO provider
// and NO LLM call (spec §6 (eventId, model)); a cold cache without an API
// key drains silently and interprets nothing, which is the honest state at
// render time (spec §2 rule 5 fallback — absence, never a spin/lie).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	_closeForTests,
	clearAllLocalData,
	getInterpretation,
	initPersistence,
	saveInterpretation
} from '$lib/db';
import { investigation, resetInvestigation } from '../src/lib/investigation.svelte';
import { settings } from '../src/lib/settings.svelte';
import type { NostrEvent as FabricEvent } from '$lib/fabric';

const MODEL = 'test-model';

function event(id: string): FabricEvent {
	return {
		id: id.padEnd(64, '0').slice(0, 64),
		sig: 'cd'.repeat(64),
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [['t', 'scrutiny-metadata']],
		content: `content of ${id}`
	};
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetInvestigation();
	settings.model = MODEL;
	settings.apiKey = ''; // no provider: the LLM can never fire in this file
});

afterEach(async () => {
	resetInvestigation();
	await _closeForTests();
});

describe('node trickle — cache-first, never lies about absence', () => {
	it('paints a primed node surface with zero LLM spend (revisited graph, spec §6)', async () => {
		// Prior visit's interpretation, persisted by the fill itself.
		await saveInterpretation('m1', MODEL, 'node', {
			title: 'Security target for the TPM module',
			typeToken: 'target',
			metaType: 'target',
			label: 'Security Target'
		});
		const admitted = [event('m1')];
		await investigation._nodeFillForTests(['m1'], admitted);
		expect(investigation.nodeTiles.get('m1')).toEqual({
			title: 'Security target for the TPM module',
			typeToken: 'target',
			metaType: 'target',
			label: 'Security Target'
		});
	});

	it('a cold cache without an API key settles silently: no tile, no write, no error', async () => {
		const admitted = [event('m1')];
		await investigation._nodeFillForTests(['m1'], admitted);
		expect(investigation.nodeTiles.has('m1')).toBe(false);
		expect(await getInterpretation('m1', MODEL)).toBeNull();
		await investigation._nodeFillForTests(['m1'], admitted);
		expect(investigation.nodeTiles.has('m1')).toBe(false);
	});
});
