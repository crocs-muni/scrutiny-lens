// Node-interpretation trickle (#29c, owner ruling C 2026-09-16): the cache
// is the fast path — a revisited graph paints sans at t≈0 with NO provider
// and NO LLM call (spec §6 (eventId, model)); a cold cache without an API
// key drains silently and interprets nothing, which is the honest state at
// render time (spec §2 rule 5 fallback — absence, never a spin/lie).
//
// The second half pins the lane's outcome accounting (issue #199): every
// drained id ends a turn as tiled, retryable or dead, in the error shapes a
// browser actually produces — a fetch `TypeError`, an abort-shaped timeout
// that THROWS, a page that never answers, a model that drops records.

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
		// Pad with a non-digit: `'n1'.padEnd(64, '0')` and `'n10'` collide.
		id: id.padEnd(64, 'x').slice(0, 64),
		sig: 'cd'.repeat(64),
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [['t', 'scrutiny-metadata']],
		content: `content of ${id}`
	};
}

/** entityIds of the events in a node-lane prompt (its payload is embedded as
 * a JSON line, not posted as the bare array the card lane sends). */
function pageIds(prompt: string): string[] {
	const at = prompt.indexOf('{"graphContext"');
	if (at < 0) return [];
	const end = prompt.indexOf('\nEmit one record', at);
	const payload = JSON.parse(prompt.slice(at, end < 0 ? undefined : end).trim()) as {
		events?: Array<{ entityId?: string }>;
	};
	return (payload.events ?? []).map((e) => e.entityId ?? '');
}

/** One valid metadata record per id. */
function recordsFor(list: readonly string[]): string {
	return list
		.map(
			(id) =>
				`entityId: ${id}\ntitle: Interpreted ${id}\ntypeToken: target\nmetaType: target\nlabel: Label ${id}`
		)
		.join('\n\n');
}

/** One valid record per asked id. */
function answer(prompt: string): string {
	return recordsFor(pageIds(prompt));
}

/** The twelve ids a graph visit can report; the events' own ids are what the
 * lane queues (it matches them against the admitted set). */
const admitted = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11', 'n12'].map(
	event
);
const ids = admitted.map((e) => e.id);
const tiled = (pool: readonly string[]): number =>
	pool.filter((id) => investigation.nodeTiles.has(id)).length;

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetInvestigation();
	settings.model = MODEL;
	// A resolvable endpoint: the lane resolves the provider before it ever
	// reaches the transport, so a blank one would short-circuit the call and
	// every assertion below would pass for the wrong reason.
	settings.endpoint = 'https://example.test/v1';
	settings.apiKey = '';
	wire.requests.length = 0;
	wire.call = null;
});

afterEach(async () => {
	resetInvestigation();
	await _closeForTests();
});

describe('node trickle — cache-first, never lies about absence', () => {
	it('paints a primed node surface with zero LLM spend (revisited graph, spec §6)', async () => {
		const subject = event('m1');
		// Prior visit's interpretation, persisted by the fill itself.
		await saveInterpretation(subject.id, MODEL, 'node', {
			title: 'Security target for the TPM module',
			typeToken: 'target',
			metaType: 'target',
			label: 'Security Target'
		});
		await investigation._nodeFillForTests([subject.id], [subject]);
		expect(investigation.nodeTiles.get(subject.id)).toEqual({
			title: 'Security target for the TPM module',
			typeToken: 'target',
			metaType: 'target',
			label: 'Security Target'
		});
	});

	it('a cold cache without an API key settles silently: no tile, no write, no error, no attempt', async () => {
		const subject = event('m1');
		await investigation._nodeFillForTests([subject.id], [subject]);
		expect(investigation.nodeTiles.has(subject.id)).toBe(false);
		expect(await getInterpretation(subject.id, MODEL)).toBeNull();
		expect(wire.requests.length).toBe(0);
		// Keyless is NOT an attempt: the id must stay askable once a key lands.
		settings.apiKey = 'test-key';
		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests([subject.id], [subject]);
		expect(investigation.nodeTiles.has(subject.id)).toBe(true);
	});
});

describe('node trickle — every id ends a turn with a verdict (#199)', () => {
	it('a browser wire death (TypeError) keeps the page that landed and re-asks the rest', async () => {
		settings.apiKey = 'test-key';
		wire.call = async (args) => {
			const prompt = args.messages.at(-1)?.content ?? '';
			if (pageIds(prompt).includes(ids[4] as string)) throw new TypeError('Failed to fetch');
			return answer(prompt);
		};
		await investigation._nodeFillForTests(ids.slice(0, 8), admitted);

		// One LLM request per page, and a failure stops the lane instead of
		// hammering a dead endpoint (the next visit is the backoff).
		expect({
			requests: wire.requests.length,
			pages: wire.requests.map((request) => pageIds(request).length)
		}).toEqual({ requests: 2, pages: [BATCH_SIZE, BATCH_SIZE] });
		expect(tiled(ids.slice(0, 4))).toBe(4);
		expect(tiled(ids.slice(4, 8))).toBe(0);

		// The failed ids were released, not poisoned: a later graph visit asks
		// again instead of leaving those records raw for the whole session.
		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests(ids.slice(4, 8), admitted);
		expect(tiled(ids.slice(0, 8))).toBe(8);
	});

	it('a failure on the first page does not poison the undrained tail', async () => {
		settings.apiKey = 'test-key';
		wire.call = async (args) => {
			const prompt = args.messages.at(-1)?.content ?? '';
			if (pageIds(prompt).includes(ids[0] as string)) throw new TypeError('Failed to fetch');
			return answer(prompt);
		};
		await investigation._nodeFillForTests(ids, admitted);
		expect(wire.requests.length).toBe(1); // stopped on the failure

		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests(ids, admitted);
		expect(tiled(ids)).toBe(12);
	});

	it('an abort-shaped page death settles the lane instead of escaping it', async () => {
		settings.apiKey = 'test-key';
		wire.call = async (args) => {
			const prompt = args.messages.at(-1)?.content ?? '';
			if (pageIds(prompt).includes(ids[0] as string))
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			return answer(prompt);
		};
		// Before the fix this rejected out of runNodeFill (an unhandled
		// rejection) and left the queue populated, so the drain-wait in
		// _nodeFillForTests never settled: the test itself could not finish.
		await investigation._nodeFillForTests(ids.slice(0, 8), admitted);
		expect(wire.requests.length).toBe(1);
		expect(tiled(ids.slice(0, 8))).toBe(0);

		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests(ids.slice(0, 8), admitted);
		expect(tiled(ids.slice(0, 8))).toBe(8);
	});

	it('caps attempts per id: a dead endpoint is asked twice, then the fallback stands', async () => {
		settings.apiKey = 'test-key';
		wire.call = async () => {
			throw new TypeError('Failed to fetch');
		};
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		expect(wire.requests.length).toBe(2);
		// The cap is spent: the third visit must not ask again.
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		expect(wire.requests.length).toBe(2);
		expect(tiled(ids.slice(0, 4))).toBe(0);
	});

	it('treats a schema failure as terminal: the rule-5 fallback stands, no retry', async () => {
		settings.apiKey = 'test-key';
		wire.call = async () => 'I am sorry, I cannot help with that request.';
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		// One page = the call plus its single re-prompt.
		expect(wire.requests.length).toBe(2);
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		expect(wire.requests.length).toBe(2);
	});

	it('does not spend attempts on the tail it never asked', async () => {
		settings.apiKey = 'test-key';
		wire.call = async () => {
			throw new TypeError('Failed to fetch');
		};
		// Visit 1 fails on the first page; the other eight ids were never
		// asked and must keep their full cap.
		await investigation._nodeFillForTests(ids, admitted);
		// Visit 2 spends the first page's second attempt, and only then.
		await investigation._nodeFillForTests(ids, admitted);
		// Visit 3: the dead page is skipped, the next page is asked.
		await investigation._nodeFillForTests(ids, admitted);
		expect(wire.requests.map((request) => pageIds(request).map((id) => id.slice(0, 3)))).toEqual([
			['n1x', 'n2x', 'n3x', 'n4x'],
			['n1x', 'n2x', 'n3x', 'n4x'],
			['n5x', 'n6x', 'n7x', 'n8x']
		]);
	});

	it('a partial page retries only the records the model dropped', async () => {
		settings.apiKey = 'test-key';
		wire.call = async (args) => {
			const asked = pageIds(args.messages.at(-1)?.content ?? '');
			return recordsFor(asked.slice(0, 2));
		};
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		expect(tiled(ids.slice(0, 4))).toBe(2);

		const before = wire.requests.length;
		wire.call = async (args) => answer(args.messages.at(-1)?.content ?? '');
		await investigation._nodeFillForTests(ids.slice(0, 4), admitted);
		// Only the dropped ids were asked, and the page holds them both.
		expect(wire.requests.length - before).toBe(1);
		expect(pageIds(wire.requests.at(-1) ?? '').length).toBe(2);
		expect(tiled(ids.slice(0, 4))).toBe(4);
	});

	it('drains a lane a redraw extends mid-run, then returns (#201)', async () => {
		settings.apiKey = 'test-key';
		let extended = false;
		wire.call = async (args) => {
			if (!extended) {
				extended = true;
				// The canvas re-derives while the first page is still open.
				investigation.nodeFillFor(ids.slice(8, 12));
			}
			return answer(args.messages.at(-1)?.content ?? '');
		};
		await investigation._nodeFillForTests(ids.slice(0, 8), admitted);
		expect(tiled(ids)).toBe(12);
	});
});

describe('node trickle — progressive paint (issue #199, D)', () => {
	it('paints a closed record before the page settles', async () => {
		settings.apiKey = 'test-key';
		const page = ids.slice(0, 2);
		let openSecond: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			openSecond = resolve;
		});
		const stream = async function* () {
			yield `entityId: ${page[0]}\ntitle: First closed\ntypeToken: target\nmetaType: target\nlabel: L1\n\n`;
			await gate;
			yield `entityId: ${page[1]}\ntitle: Second closed\ntypeToken: target\nmetaType: target\nlabel: L2\n\n`;
		};
		const running = investigation._nodeFillForTests(page, admitted, stream);

		// The first block is complete, the second has not arrived: one tile,
		// not two, while the page is still open.
		await vi.waitFor(() => expect(investigation.nodeTiles.get(page[0] as string)?.title).toBe('First closed'));
		expect(investigation.nodeTiles.has(page[1] as string)).toBe(false);

		openSecond();
		await running;
		expect(investigation.nodeTiles.get(page[1] as string)?.title).toBe('Second closed');
	});
});
