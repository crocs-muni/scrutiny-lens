// Node-interpretation trickle (#29c, owner ruling C 2026-09-16): the cache
// is the fast path — a revisited graph paints sans at t≈0 with NO provider
// and NO LLM call (spec §6 (eventId, model)); a cold cache without an API
// key drains silently and interprets nothing, which is the honest state at
// render time (spec §2 rule 5 fallback — absence, never a spin/lie).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The node lane's transport, swappable per test: the lane under test calls
 * the REAL batch pipeline, so only the wire is faked. `vi.hoisted` keeps the
 * handle visible to the mock factory vitest hoists above the imports. */
const wire = vi.hoisted(() => ({
	call: null as null | ((args: { messages: Array<{ content: string }> }) => Promise<string>),
	requests: [] as string[]
}));

vi.mock('$lib/ai/output', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../src/lib/ai/output')>();
	return {
		...mod,
		defaultCallLLM: (args: { messages: Array<{ content: string }> }) => {
			wire.requests.push(args.messages.at(-1)?.content ?? '');
			return (wire.call ?? mod.defaultCallLLM)(args as never);
		}
	};
});

import {
	_closeForTests,
	clearAllLocalData,
	getInterpretation,
	initPersistence,
	saveInterpretation
} from '$lib/db';
import { investigation, resetInvestigation } from '../src/lib/investigation.svelte';
import { BATCH_SIZE } from '$lib/ai/agents/nodes';
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

describe('node trickle — a failed page cannot sink the batch, a revisit finishes it', () => {
	// The lane queues PLACED ids and matches them against admitted events, so
	// the queue must carry the events' own ids — not the helper's short names.
	const admitted = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'].map(event);
	const ids = admitted.map((e) => e.id);
	const FAILED_FROM = ids[4] as string;

	/** entityIds of the events in a node-lane prompt (its payload is embedded
	 * as a JSON line, not posted as the bare array the card lane sends). */
	function pageIds(prompt: string): string[] {
		const at = prompt.indexOf('{"graphContext"');
		if (at < 0) return [];
		const end = prompt.indexOf('\nEmit one record', at);
		const payload = JSON.parse(prompt.slice(at, end < 0 ? undefined : end).trim()) as {
			events?: Array<{ entityId?: string }>;
		};
		return (payload.events ?? []).map((e) => e.entityId ?? '');
	}

	function answer(prompt: string): string {
		return pageIds(prompt)
			.map(
				(id) =>
					`entityId: ${id}\ntitle: Interpreted ${id}\ntypeToken: target\nmetaType: target\nlabel: Label ${id}`
			)
			.join('\n\n');
	}

	it('fills the pages that landed and re-asks the failed one on the next visit', async () => {
		settings.apiKey = 'test-key';
		// A resolvable endpoint + model: the lane resolves the provider before
		// it ever reaches the transport, so a blank one would short-circuit the
		// call and the test would pass for the wrong reason.
		settings.endpoint = 'https://example.test/v1';
		wire.requests.length = 0;
		// The second page dies on the wire (the cold-endpoint / deadline class).
		// One shared call and deadline for every page made both pages die
		// together — the batch dropped nothing and saved nothing.
		wire.call = async (args) => {
			const prompt = args.messages.at(-1)?.content ?? '';
			if (pageIds(prompt).includes(FAILED_FROM)) throw new Error('fetch failed');
			return answer(prompt);
		};

		await investigation._nodeFillForTests(ids, admitted);

		// One LLM request per page: the lane must not hand a single call more
		// events than the agent pages on its own, or the per-call deadline is
		// shared across pages again.
		expect(wire.requests.length).toBe(2);
		for (const request of wire.requests) {
			expect(pageIds(request).length).toBeLessThanOrEqual(BATCH_SIZE);
		}
		for (const id of ids.slice(0, 4)) {
			expect(investigation.nodeTiles.get(id)?.title).toBe(`Interpreted ${id}`);
		}
		for (const id of ids.slice(4)) {
			expect(investigation.nodeTiles.has(id)).toBe(false);
		}

		// The failed ids were released, not poisoned: a later graph visit asks
		// again instead of leaving those records raw for the whole session.
		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests(ids.slice(4), admitted);
		for (const id of ids) {
			expect(investigation.nodeTiles.has(id)).toBe(true);
		}
	});
});
