// Reload-restore + late-key refill (issues #83/#84, spec §2/§6): a reopened
// session rebuilds its settled surface from the pinned run record plus the
// shared events cache — deterministic reassembly and persisted
// interpretations only, never a re-query. Declines are honest: no run row or
// a fully evicted frontier names the session in restoreMissId and the relic
// placeholder takes over. A key entered after the session loaded re-runs the
// card fill lane and re-arms the node trickle's keyless-drained queue.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_closeForTests,
	cacheEvent,
	clearAllLocalData,
	getInterpretation,
	getSessionRun,
	initPersistence,
	putSessionRun,
	saveInterpretation
} from '$lib/db';
import { investigation, resetInvestigation } from '../src/lib/investigation.svelte';
import { resetShell, shell } from '../src/lib/shell.svelte';
import { settings } from '../src/lib/settings.svelte';
import type { NostrEvent } from 'nostr-tools/core';
import type { SearchSession } from '$lib/pipeline';
import type { SearchRequest } from '$lib/ai/agents/query';
import type { CallLLM } from '../src/lib/ai/output';

const MODEL = 'test-model';
const SEARCHES: SearchRequest[] = [{ kind: 'tag', value: 'cve:CVE-2017-15361', source: 'ai' }];

/** Padded lowercase-hex id — the fabric seam's structural gate (64-hex id)
 * sees only this form (same helper shape as cards.test.ts). Fixture ids must
 * start DISTINCT hex-passing letters (a–f, digits): 'p1' and 'm1' both
 * sanitize to '01…' — the same row key — and overwrite each other in the
 * events store (learned the hard way on the first green run). */
function hex(s: string, len = 64): string {
	return s.padEnd(len, '0').slice(0, len).replaceAll(/[^0-9a-f]/g, '0');
}

/** Protocol-valid product (version tag required by core's TAG-2 rule). */
function product(id: string): NostrEvent {
	return {
		id: hex(id),
		sig: 'cd'.repeat(64),
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-product'],
			['t', 'scrutiny-v0.8.1'],
			['i', 'cve:CVE-2017-15361']
		],
		content: `content of ${id}`
	};
}

function metadata(id: string): NostrEvent {
	return {
		id: hex(id),
		sig: 'cd'.repeat(64),
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-metadata'],
			['t', 'scrutiny-v0.8.1']
		],
		content: `content of ${id}`
	};
}

/** The settled-run row a reload-restore reads back (issue #83's frontier pin). */
async function pinRun(
	sessionId: string,
	admittedIds: string[],
	elapsedMs: number | null = 4_200
): Promise<void> {
	await putSessionRun({
		sessionId,
		searches: SEARCHES,
		// Explicit closure: `map(hex)` would feed the array INDEX into
		// hex's `len` parameter — the trap that made the first run's ids "" / "0".
		admittedIds: admittedIds.map((id) => hex(id)),
		settledAt: 1_700_000_001_000,
		elapsedMs
	});
}

/** One KV record per id the fill asked about (same shape as fillLanes.test.ts). */
function kvAnswer(callLLMArgs: Parameters<CallLLM>[0]): string {
	const asked = JSON.parse(callLLMArgs.messages[0].content as string) as { id: string }[];
	return asked.map((a) => `id: ${a.id}\ntitle: T-${a.id}\nsnippet: S-${a.id}`).join('\n\n');
}

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetInvestigation();
	resetShell();
	settings.model = MODEL;
	settings.apiKey = '';
});

afterEach(async () => {
	resetInvestigation();
	resetShell();
	await _closeForTests();
});

describe('restore — rebuilds the settled surface (issue #83)', () => {
	it('rebuilds session, cards, and facets from the pinned frontier + events cache', async () => {
		await cacheEvent(product('a1'));
		await cacheEvent(metadata('b1'));
		await pinRun('s1', ['a1', 'b1']);

		expect(await investigation.restore('s1')).toBe(true);

		expect(investigation.sessionId).toBe('s1');
		expect(investigation.result?.admitted.map((e) => e.id)).toEqual([hex('a1'), hex('b1')]);
		expect(investigation.searches).toEqual(SEARCHES);
		// One card per root PRODUCT — bound metadata never inflates the rail (spec §3).
		expect(investigation.cards.map((c) => c.id)).toEqual([hex('a1')]);
		expect(investigation.facetGroups.length).toBeGreaterThan(0);
		expect(investigation.phase).toBe('done');
		expect(investigation.running).toBe(false);
		expect(investigation.elapsedMs).toBe(4_200);
		expect(investigation.restoredEvicted).toBe(0);
		expect(investigation.restoreMissId).toBeNull();
	});

	it('paints persisted card interpretations KEYLESS (local data, no endpoint — spec §6)', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		await saveInterpretation(hex('a1'), MODEL, 'card', {
			title: 'ROCA vulnerable Infineon chips',
			snippet: 'Persisted prose from an earlier run.'
		});

		expect(await investigation.restore('s1')).toBe(true);

		const card = investigation.cards.find((c) => c.id === hex('a1'));
		expect(card?.interpreted).toBe(true);
		expect(card?.title).toBe('ROCA vulnerable Infineon chips');
		expect(card?.snippet).toBe('Persisted prose from an earlier run.');
	});

	it("a model mismatch never paints another model's prose (cache key is (eventId, model))", async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		await saveInterpretation(hex('a1'), 'other-model', 'card', {
			title: 'Written by other-model',
			snippet: 'Not ours to paint.'
		});

		expect(await investigation.restore('s1')).toBe(true);

		const card = investigation.cards.find((c) => c.id === hex('a1'));
		expect(card?.interpreted).toBe(false);
		// Rule-5 fallback: the event's own first i-tag, never invented prose.
		expect(card?.title).toBe('cve:CVE-2017-15361');
	});

	it('counts evicted ids instead of hiding them (partially evicted frontier)', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1', 'e1']);

		expect(await investigation.restore('s1')).toBe(true);

		expect(investigation.result?.admitted.map((e) => e.id)).toEqual([hex('a1')]);
		expect(investigation.restoredEvicted).toBe(1);
	});
});

describe('restore — honest declines (issue #83)', () => {
	it('declines a session with no run row and names it for the relic placeholder', async () => {
		expect(await investigation.restore('s-relic')).toBe(false);

		expect(investigation.restoreMissId).toBe('s-relic');
		expect(investigation.result).toBeNull();
		expect(investigation.sessionId).toBeNull();
	});

	it('declines a run row whose whole frontier was evicted from the cache', async () => {
		await pinRun('s-gone', ['x1', 'x2']);

		expect(await investigation.restore('s-gone')).toBe(false);

		expect(investigation.restoreMissId).toBe('s-gone');
		expect(investigation.result).toBeNull();
	});
});

describe('restore — displacement (owner ruling 2026-09-26: restore wins the surface)', () => {
	it('pins the displaced settled run before the restore paints', async () => {
		await cacheEvent(product('c1'));
		await pinRun('s1', ['c1']);
		// Public-field drive: a settled run is exactly a rail row + sessionId
		// + result — its events need not be cached for the pin to record the
		// frontier (the M5 orphan guard reads the rail row).
		shell.sessions.push({ id: 'old', title: 'old run', createdAt: 1 });
		investigation.sessionId = 'old';
		investigation.result = {
			searches: [],
			admitted: [product('a1'), metadata('b1')],
			invalidSkipped: 0,
			notices: [],
			relays: []
		} as SearchSession;

		expect(await investigation.restore('s1')).toBe(true);

		// persistRunRecord is fire-and-forget like the orchestrator's other
		// write-through — poll the read-back instead of racing the commit.
		await vi.waitFor(async () => {
			expect((await getSessionRun('old'))?.admittedIds).toEqual([hex('a1'), hex('b1')]);
		});
	});

	it('pins nothing for a session row the rail no longer holds (review M5)', async () => {
		// stop() + closeSession on a settled run cascades its row away; a
		// late restore-displacement or settle pin must not re-pin it.
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		shell.sessions.push({ id: 'off', title: 'off', createdAt: 1 });
		shell.closeSession('off'); // rail row + persisted rows gone
		investigation.sessionId = 'off';
		investigation.result = {
			searches: [],
			admitted: [product('c1')],
			invalidSkipped: 0,
			notices: [],
			relays: []
		} as SearchSession;

		expect(await investigation.restore('s1')).toBe(true);
		// The M5 guard no-ops synchronously — no write ever left the seam.
		expect(await getSessionRun('off')).toBeNull();
	});
});

describe('restore — races (last click wins)', () => {
	it('restore-vs-restore: the superseded restore paints nothing and returns false', async () => {
		await cacheEvent(product('a1'));
		await cacheEvent(product('c1'));
		await pinRun('s1', ['a1']);
		await pinRun('s2', ['c1']);

		const first = investigation.restore('s1');
		const second = investigation.restore('s2');
		const [r1, r2] = await Promise.all([first, second]);

		expect(r1).toBe(false);
		expect(r2).toBe(true);
		expect(investigation.sessionId).toBe('s2');
		expect(investigation.result?.admitted.map((e) => e.id)).toEqual([hex('c1')]);
	});
});

describe('keyArrived — late key re-interprets the loaded session (issue #84)', () => {
	it('fills the raw restored cards and persists the prose', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s-late', ['a1']);
		// Node surface pre-primed: the re-armed node trickle paints from cache
		// and never reaches the endpoint — this test drives the CARD lane.
		await saveInterpretation(hex('a1'), MODEL, 'node', {
			title: 'A1 as node',
			typeToken: 'product'
		});
		expect(await investigation.restore('s-late')).toBe(true);
		expect(investigation.cards.find((c) => c.id === hex('a1'))?.interpreted).toBe(false);

		settings.apiKey = 'sk-late-key';
		// The identity gate (review) answers fills for the OPEN session only —
		// tests drive keyArrived directly, so they stand up the rail view.
		shell.session = { id: 's-late', title: 't', createdAt: 0 };
		// Batch-path seam: the public lane uses the production stream, which
		// would route around the injected fake to the real gateway.
		await investigation._keyArrivedForTests(async (args) => kvAnswer(args));

		const card = investigation.cards.find((c) => c.id === hex('a1'));
		expect(card?.interpreted).toBe(true);
		expect(card?.title).toBe(`T-${hex('a1')}`);
		// Same (eventId, model) persistence the live fill lane writes — the
		// save is fire-and-forget inside fillCards, so poll the read-back.
		await vi.waitFor(async () => {
			const hit = await getInterpretation(hex('a1'), MODEL);
			expect(hit?.bySurface.card).toEqual({
				title: `T-${hex('a1')}`,
				snippet: `S-${hex('a1')}`
			});
		});
	});

	it('re-arms the keyless-drained node queue; the cache pass needs NO call', async () => {
		const m9: NostrEvent = {
			id: 'm9',
			sig: 'cd'.repeat(64),
			pubkey: 'ef'.repeat(32),
			created_at: 1_700_000_000,
			kind: 1,
			tags: [['t', 'scrutiny-metadata']],
			content: 'content of m9'
		};
		// The incident itself: the keyless pass painted nothing and drained
		// the queue permanently.
		await investigation._nodeFillForTests(['m9'], [m9]);
		expect(investigation.nodeTiles.has('m9')).toBe(false);

		// Another surface (a revisit, a sync) persisted the node meanwhile.
		await saveInterpretation('m9', MODEL, 'node', { title: 'N9', typeToken: 'target' });
		settings.apiKey = 'sk-late-key';
		// Identity gate seam — the node lane owns no shell view either.
		shell.session = { id: 'm-node', title: 't', createdAt: 0 };
		investigation.sessionId = 'm-node';
		await investigation._keyArrivedForTests(async () => {
			throw new Error('no LLM expected');
		});

		expect(investigation.nodeTiles.get('m9')?.title).toBe('N9');
	});

	it('refuses to fill for a session that is not the open one (session-identity gate)', async () => {
		// Key committed DURING a restore: the painted run is still the old
		// session, shell already points at the new one. By-index merges onto
		// wrong-session cards are a spec §2 violation — the fill must bail.
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		expect(await investigation.restore('s1')).toBe(true);
		settings.apiKey = 'sk-late-key';
		shell.session = { id: 'other', title: 't', createdAt: 0 };

		const spy = vi.fn();
		await investigation._keyArrivedForTests(spy as unknown as CallLLM);

		expect(spy).not.toHaveBeenCalled();
		expect(investigation.cards.every((c) => !c.interpreted)).toBe(true);
	});

	it('no-ops on a settled session where every card is already interpreted', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		await saveInterpretation(hex('a1'), MODEL, 'card', { title: 'Cached', snippet: 'Cached.' });
		await saveInterpretation(hex('a1'), MODEL, 'node', { title: 'N', typeToken: 'product' });
		expect(await investigation.restore('s1')).toBe(true);
		expect(investigation.cards.every((c) => c.interpreted)).toBe(true);

		settings.apiKey = 'sk-late-key';
		shell.session = { id: 's1', title: 't', createdAt: 0 };
		const spy = vi.fn();
		await investigation._keyArrivedForTests(spy as unknown as CallLLM);

		expect(spy).not.toHaveBeenCalled();
		expect(investigation.filling).toBe(false);
	});
});

describe('restore — supersession and shared opens (review H2/L8)', () => {
	it('start() supersedes an in-flight restore: the late commit lands nowhere', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		settings.relays = []; // start() settles locally — transport construction throws into its own net, no network
		const restoring = investigation.restore('s1');
		void investigation.start('fresh question');

		expect(await restoring).toBe(false);
		// The new run owns the paint — the restore's session/cards/results
		// never land, and the new session's row keeps its own identity.
		expect(investigation.sessionId).toBe(shell.session?.id);
		expect(investigation.sessionId).not.toBe('s1');
	});

	it('a shared open pins its run row after the context sweep, so shares restore too (L8)', async () => {
		settings.relays = []; // the sweep fails fast with zero relays — the pin must still land
		const root = product('r1');
		await investigation.openShared(root, [], false);
		const id = shell.session?.id ?? '';
		expect(id).not.toBe('');

		await vi.waitFor(async () => {
			const row = await getSessionRun(id);
			expect(row?.admittedIds).toEqual([hex('r1')]);
			expect(row?.searches).toEqual([]);
		});
	});
});

describe('resetInvestigation — full-surface seam (review L9)', () => {
	it('clears every settled/restore field, including the backfilled five', async () => {
		await cacheEvent(product('a1'));
		await pinRun('s1', ['a1']);
		expect(await investigation.restore('s1')).toBe(true);
		investigation.lastQuestion = 'dirty';
		investigation.graphSubjectId = hex('a1');
		investigation.expandedRelated = [hex('a1')];
		investigation.hasShareHints = true;

		resetInvestigation();

		expect(investigation.sessionId).toBeNull();
		expect(investigation.restoredEvicted).toBeNull();
		expect(investigation.restoreMissId).toBeNull();
		expect(investigation.lastQuestion).toBe('');
		expect(investigation.graphSubjectId).toBeNull();
		expect(investigation.expandedRelated).toEqual([]);
		expect(investigation.hasShareHints).toBe(false);
		expect(investigation.result).toBeNull();
		expect(investigation.cards).toEqual([]);
		expect(investigation.searches).toEqual([]);
	});
});
