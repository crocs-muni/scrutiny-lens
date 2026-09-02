import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { CallLLM, CallLLMArgs } from '$lib/ai/output';
import { clearDeadLetters, deadLetters } from '$lib/ai/deadLetter';
import {
	interpretCards,
	CardVMSchema,
	BATCH_SIZE,
	metaSegmentsRule,
	matchBandRule,
	validateMatchReasons,
	snippetRules
} from '$lib/ai/agents/cards';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

/* ---------- helpers ---------- */

function event(overrides: Partial<NostrEvent> & { tags?: string[][] } = {}): NostrEvent {
	const { tags = [], content = 'Infineon RSA library used in smartcards (ROCA).', ...rest } = overrides;
		return {
			id: 'ev-1',
			sig: 'sig',
			pubkey: 'pk',
			created_at: 1700000000,
			kind: 1,
			tags,
			content,
			...rest
		};
}

function graph(i: number, overrides: { tags?: string[][]; content?: string } = {}) {
	const id = `ev-${i}`;
	return {
		entityId: id,
		event: event({ id, tags: overrides.tags ?? [], content: overrides.content }),
		neighbors: [],
		stats: { boundMetadata: 2, attachments: 1, updates: 0 }
	};
}

function mkDraft(j: number): Record<string, unknown> {
	return {
		title: `Card ${j}`,
		typeToken: 'certificate',
		snippet: { text: 'BSI EAL4 certificate smartcard covered by the analysis.', highlights: [] },
		match: 0.7
	};
}

/** fake LLM returning a fixed JSON page. */
function fakeLLM(json: string): { call: CallLLM; calls: CallLLMArgs[] } {
	const calls: CallLLMArgs[] = [];
	const call: CallLLM = async (args) => {
		calls.push(args);
		return json;
	};
	return { call, calls };
}

const validPage = (n: number) => JSON.stringify({ cards: Array.from({ length: n }, (_, j) => mkDraft(j)) });

/* ---------- dead-letter isolation ---------- */

beforeEach(() => clearDeadLetters());

function deadLetterRows() {
	return deadLetters().map((e) => ({ entityId: e.entityId, reason: e.reason }));
}

/* ---------- batch ---------- */

describe('interpretCards batch', () => {
	it('pages 14 graphs into exactly 2 LLM calls and preserves order', async () => {
		const graphs = Array.from({ length: 14 }, (_, i) => graph(i));
		const { call, calls } = fakeLLM(validPage(12));
		const res = await interpretCards({ graphs, query: 'BSI EAL4 certificate', provider: PROVIDER, callLLM: call });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(calls).toHaveLength(2); // 12 + 2
		expect(res.result.cards).toHaveLength(14);
		for (let i = 0; i < 14; i++) {
			expect(res.result.cards[i].entityId).toBe(graphs[i].entityId);
		}
	});

	it('produces a well-formed CardVM with deterministic + validated fields', async () => {
		const graphs = [
			graph(0, {
				tags: [
					['identifier', 'cve:CVE-2017-15361'],
					['scheme', 'BSI · Germany'],
					['eal', 'EAL4+'],
					['status', 'active']
				],
				content: 'Infineon RSA library CA in smartcards (ROCA).'
			})
		];
		const draft = {
			title: 'Infineon ROCA-affected smartcard library',
			typeToken: 'certificate',
			vendor: 'Infineon',
			snippet: { text: 'BSI EAL4 certificate smartcard covered by the analysis.', highlights: [] },
			matchReasons: ['identifier: CVE-2017-15361', 'status: active'],
			match: 0.65
		};
		const { call } = fakeLLM(JSON.stringify({ cards: [draft] }));
		const res = await interpretCards({ graphs, query: 'BSI EAL4 certificate smartcard', provider: PROVIDER, callLLM: call });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const card = res.result.cards[0];
		expect(card.title).toBe('Infineon ROCA-affected smartcard library');
		expect(card.vendor).toBe('Infineon');
		expect(card.typeToken).toBe('certificate');
		expect(card.identifiers).toEqual(['cve:CVE-2017-15361']);
		expect(card.metaSegments).toEqual(['BSI · Germany', 'EAL4+', 'Active']);
		expect(card.status).toBe('active');
		expect(card.stats).toEqual({ boundMetadata: 2, attachments: 1, updates: 0 });
		expect(card.snippet.text).toBe('BSI EAL4 certificate smartcard covered by the analysis.');
		expect(card.matchReasons).toContain('identifier: CVE-2017-15361');
		expect(card.matchReasons).toContain('status: active');
		expect(card.match).toBe(0.65);
	});

	it('degrades only a schema-failing item to a skeleton and writes dead_letter, keeping the batch', async () => {
		const graphs = [graph(0), graph(1), graph(2)];
		const good = mkDraft(99);
		const json = JSON.stringify({
			cards: [good, { ...good, typeToken: 'banana' }, good]
		});
		const { call } = fakeLLM(json);
		const res = await interpretCards({ graphs, query: 'BSI EAL4 certificate', provider: PROVIDER, callLLM: call });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const cards = res.result.cards;
		expect(cards).toHaveLength(3);
		expect(cards[0].typeToken).toBe('certificate');
		expect(cards[2].typeToken).toBe('certificate');
		const degraded = cards[1];
		expect(degraded.typeToken).toBe('unknown');
		expect(degraded.matchReasons).toEqual([]);
		expect(degraded.snippet.text).toBe('');
		const rows = deadLetterRows().filter((r) => r.entityId === 'ev-1');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((r) => r.reason.includes('card validation failed'))).toBe(true);
	});

	it('maps an LLM timeout to kind unreachable', async () => {
		const call: CallLLM = async () => {
			throw new Error('request timed out after 30s');
		};
		const res = await interpretCards({
			graphs: [graph(0)],
			query: 'cve',
			provider: PROVIDER,
			callLLM: call
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('unreachable');
	});

	it('returns schema_failure when the whole page response is structurally invalid', async () => {
		const call: CallLLM = async () => '{"notcards":[]}';
		const res = await interpretCards({ graphs: [graph(0)], query: 'cve', provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('schema_failure');
	});
});

describe('matchBandRule', () => {
	it('identifier hit → high', () => {
		expect(matchBandRule('cve:CVE-2017-15361', ['cve:CVE-2017-15361'], {})).toBe('high');
	});
	it('term coverage 60% only → medium', () => {
		expect(
			matchBandRule(
				'BSI Infineon EAL4 wing oar',
				['cpe:2.3:o:x:y'],
				{ scheme: ['BSI', 'Infineon'], assurance: ['EAL4+'] }
			)
		).toBe('medium');
	});
	it('below thresholds → low', () => {
		expect(matchBandRule('rotor wifi zeta', ['BSI-DSZ-CC-0814-2012'], { scheme: ['BSI'] })).toBe('low');
	});
});

describe('validateMatchReasons', () => {
	it('drops an invented identifier and writes a dead_letter row', () => {
		const input = {
			entityId: 'ev-1',
			profile: 'generic',
			model: 'test-model',
			identifiers: ['cve:CVE-2017-15361'],
			status: 'active',
			facets: {}
		};
		const kept = validateMatchReasons(['identifier: CVE-FAKE-9999'], input);
		expect(kept).toEqual([]);
		const rows = deadLetterRows();
		expect(rows.length).toBe(1);
		expect(rows[0].reason).toContain('unverifiable match reason');
		expect(rows[0].reason).toContain('CVE-FAKE-9999');
	});

	it('keeps a reason that rebinds to a real identifier', () => {
		const input = {
			entityId: 'ev-1',
			profile: 'generic',
			model: 'test-model',
			identifiers: ['cve:CVE-2017-15361'],
			status: 'active',
			facets: {}
		};
		expect(validateMatchReasons(['identifier: CVE-2017-15361'], input)).toEqual([
			'identifier: CVE-2017-15361'
		]);
	});
});

describe('metaSegmentsRule', () => {
	it('composes scheme + status with no dangling separator when EAL is missing', () => {
		expect(metaSegmentsRule({ scheme: 'BSI · Germany', status: 'active' })).toEqual([
			'BSI · Germany',
			'Active'
		]);
		expect(metaSegmentsRule({ scheme: 'BSI · Germany' })).toEqual(['BSI · Germany']);
		expect(metaSegmentsRule({})).toEqual([]);
		// statuses get no title-case label beyond the two protocol ones —
		// 'archived' is gone from the vocabulary (spec §2 rule 2).
		expect(metaSegmentsRule({ scheme: 'BSI · Germany', assurance: 'EAL4+', status: 'retracted' })).toEqual([
			'BSI · Germany',
			'EAL4+',
			'Retracted'
		]);
	});
});

describe('snippetRules', () => {
	it('R1: a query term missing from the text degrades', () => {
		expect(snippetRules('plain summary', 'alpha', [], [])).toEqual({ ok: false, rule: 'R1' });
	});
	it('R2: query term only after the first 12 words degrades', () => {
		const text = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 alpha tail';
		expect(snippetRules(text, 'alpha', [], [])).toEqual({ ok: false, rule: 'R2' });
	});
	it('R3: text identical to the meta lead line degrades', () => {
		expect(snippetRules('BSI · Germany EAL4+', 'BSI EAL4', [], ['BSI · Germany EAL4+'])).toEqual({
			ok: false,
			rule: 'R3'
		});
	});
	it('R5: more than two highlight spans degrades', () => {
		expect(
			snippetRules(
				'alpha sorted summary',
				'alpha',
				[
					{ start: 0, len: 5 },
					{ start: 0, len: 4 },
					{ start: 0, len: 3 }
				],
				['']
			)
		).toEqual({ ok: false, rule: 'R5' });
	});
	it('R6: text over 300 chars degrades', () => {
		expect(snippetRules('alpha ' + 'a'.repeat(340), 'alpha', [], [])).toEqual({
			ok: false,
			rule: 'R6'
		});
	});
	it('R7: banned opener degrades', () => {
		expect(snippetRules('This event is a summary of alpha', 'alpha', [], [])).toEqual({
			ok: false,
			rule: 'R7'
		});
	});
	it('R8: shared ≥12-char substring with a meta segment degrades', () => {
		const text = 'blah '.repeat(20) + 'BSI-DSZ-CC-0814-2012' + ' blah';
		expect(
			snippetRules(text, 'blah', [], ['BSI-DSZ-CC-0814-2012', 'EAL4+ German scheme documentation'])
		).toEqual({ ok: false, rule: 'R8' });
	});
});

describe('typeToken gate', () => {
	it('rejects an unrecognized token', () => {
		const base = {
			entityId: 'ev-1',
			title: 'Infineon smartcard',
			identifiers: ['cve:CVE-2017-15361'],
			status: 'active' as const,
			metaSegments: [],
			matchBand: 'high' as const,
			matchReasons: [],
			snippet: { text: 'x', highlights: [] },
			match: 0.9,
			stats: { boundMetadata: 0, attachments: 0, updates: 0 },
			facets: {}
		};
		expect(CardVMSchema.safeParse({ ...base, typeToken: 'banana' }).success).toBe(false);
		expect(CardVMSchema.safeParse({ ...base, typeToken: 'certificate' }).success).toBe(true);
	});
});

it('BATCH_SIZE is exported and equals 12', () => {
	expect(BATCH_SIZE).toBe(12);
});
