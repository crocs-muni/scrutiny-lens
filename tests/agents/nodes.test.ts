import { describe, it, expect, beforeEach } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import type { CallLLM, CallLLMArgs } from '$lib/ai/output';
import { clearDeadLetters, deadLetters } from '$lib/ai/deadLetter';
import {
	batchNodeInterpret,
	BATCH_SIZE,
	ProductNodeVMSchema,
	VulnerabilityNodeVMSchema,
	MetadataNodeVMSchema,
	UnknownNodeVMSchema
} from '$lib/ai/agents/nodes';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

/* ---------- fabric-conformant fixtures ---------- */

const PUBKEY = 'a'.repeat(64);
const SIG = 'b'.repeat(128);

function hexId(seed: number): string {
	return seed.toString(16).padStart(2, '0').repeat(32);
}

function fabric(seed: number, typeTag: string, extraTags: string[][], content: string): NostrEvent {
	return {
		id: hexId(seed),
		pubkey: PUBKEY,
		sig: SIG,
		kind: 1,
		created_at: 1785542440 + seed,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', typeTag],
			['t', 'scrutiny-v0.8.0'],
			...extraTags
		],
		content
	};
}

function product(seed: number, extraTags: string[][] = [], content = 'Infineon M7794 A2 smartcard IC.'): NostrEvent {
	return fabric(seed, 'scrutiny-product', extraTags, content);
}

function metadata(seed: number, content: string, extraTags: string[][] = []): NostrEvent {
	return fabric(seed, 'scrutiny-metadata', extraTags, content);
}

function binding(seed: number, rootId: string, linkId: string, content: string): NostrEvent {
	return fabric(seed, 'scrutiny-binding', [
		['e', rootId, '', 'root', PUBKEY],
		['e', linkId, '', 'link', PUBKEY]
	], content);
}

function patch(seed: number, targetId: string): NostrEvent {
	return fabric(seed, 'scrutiny-patch', [['e', targetId, '', 'root', PUBKEY]], '```diff\n title: rename\n```');
}

/** A plain non-fabric note: not-a-SCRUTINY event → routed to kind 'unknown'. */
function plainEvent(seed: number, content: string): NostrEvent {
	return {
		id: hexId(seed),
		pubkey: PUBKEY,
		sig: SIG,
		kind: 1,
		created_at: 1785542440 + seed,
		tags: [],
		content
	};
}

/* ---------- fake LLM ---------- */

function fakeLLM(json: string): { call: CallLLM; calls: CallLLMArgs[] } {
	const calls: CallLLMArgs[] = [];
	const call: CallLLM = async (args) => {
		calls.push(args);
		return json;
	};
	return { call, calls };
}

const CTX = { rootSummary: 'Infineon M7794 · ROCA exposure', query: 'ROCA' };

/* ---------- dead-letter isolation ---------- */

beforeEach(() => clearDeadLetters());

function deadLetterRows(): Array<{ entityId: string; reason: string }> {
	return deadLetters().map((e) => ({ entityId: e.entityId, reason: e.reason }));
}

/* ---------- per-kind routing ---------- */

describe('batchNodeInterpret — kind dispatch', () => {
	it('routes a fabric product to a ProductNodeVM with deterministic + draft fields', async () => {
		const prod = product(1, [
			['identifier', 'BSI-DSZ-CC-0814-2012'],
			['scheme', 'BSI'],
			['eal', 'EAL4+'],
			['status', 'active']
		]);
		const report = metadata(2, 'Security target for M7794 A2.', [['m', 'report']]);
		const edge = binding(3, prod.id, report.id, 'Security Target binding.');
		const upd = patch(4, prod.id);

		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [
					{ title: 'Infineon M7794 A2', typeToken: 'smartcard', isRoot: true },
					{ title: 'Security target', typeToken: 'report', label: 'Security target M7794', metaType: 'report' },
					{ title: 'ST binding', typeToken: 'document', summary: 'Security Target binding.' },
					{ title: 'Rename patch', typeToken: 'patch', summary: ' title: rename' }
				]
			})
		);

		const res = await batchNodeInterpret({ events: [prod, report, edge, upd], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[0];
		expect(ProductNodeVMSchema.safeParse(node).success).toBe(true);
		if (node.kind !== 'product') throw new Error('expected product');
		expect(node.entityId).toBe(prod.id);
		expect(node.title).toBe('Infineon M7794 A2');
		expect(node.typeToken).toBe('smartcard');
		expect(node.status).toBe('active');
		expect(node.retracted).toBe(false);
		expect(node.isRoot).toBe(true);
		expect(node.identifier).toBe('BSI-DSZ-CC-0814-2012');
		expect(node.scheme).toBe('BSI');
		expect(node.assurance).toBe('EAL4+');
		expect(node.updates).toBe(1); // the patch e-tags the product
		expect(node.bindings).toEqual([{ metaType: 'report', label: 'Security Target binding.' }]);
	});

	it('routes a fabric product with a cve tag to a VulnerabilityNodeVM', async () => {
		const vuln = product(1, [['cve', 'CVE-2017-15361']], 'ROCA: Return of Coppersmith Attack on RSA key generation.');
		const prod = product(2, [], 'Infineon M7794 A2 smartcard IC.');
		const edge = binding(3, vuln.id, prod.id, 'Affected product binding.');

		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [
					{ title: 'ROCA', typeToken: 'vulnerability', identifier: 'CVE-2017-15361', identifierKind: 'cve', severity: 'High' },
					{ title: 'M7794', typeToken: 'smartcard' },
					{ title: 'binding', typeToken: 'document', summary: 'Affected product binding.' }
				]
			})
		);

		const res = await batchNodeInterpret({ events: [vuln, prod, edge], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[0];
		expect(VulnerabilityNodeVMSchema.safeParse(node).success).toBe(true);
		if (node.kind !== 'vulnerability') throw new Error('expected vulnerability');
		expect(node.identifier).toBe('CVE-2017-15361');
		expect(node.identifierKind).toBe('cve');
		expect(node.severity).toBe('High');
	});

	it('routes a fabric metadata event to a MetadataNodeVM', async () => {
		const prod = product(1);
		const report = metadata(2, 'Certification report for M7794 A2.', [['m', 'report']]);
		const edge = binding(3, prod.id, report.id, 'Certification report.');

		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [
					{ title: 'M7794', typeToken: 'smartcard' },
					{ title: 'Certification report', typeToken: 'report', label: 'Certification report M7794', metaType: 'report', date: '2024-05' },
					{ title: 'binding', typeToken: 'document', summary: 'Certification report.' }
				]
			})
		);

		const res = await batchNodeInterpret({ events: [prod, report, edge], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[1];
		expect(MetadataNodeVMSchema.safeParse(node).success).toBe(true);
		if (node.kind !== 'metadata') throw new Error('expected metadata');
		expect(node.metaType).toBe('report');
		expect(node.label).toBe('Certification report M7794');
		expect(node.date).toBe('2024-05');
	});

	it('routes a non-fabric event to an UnknownNodeVM with a quote-verified summary', async () => {
		const note = plainEvent(1, 'Oddball relay note mentioning RSA libraries in smartcards (ROCA).');
		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [{ title: 'Oddball note', typeToken: 'document', summary: 'mentioning RSA libraries in smartcards' }]
			})
		);

		const res = await batchNodeInterpret({ events: [note], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[0];
		expect(UnknownNodeVMSchema.safeParse(node).success).toBe(true);
		if (node.kind !== 'unknown') throw new Error('expected unknown');
		expect(node.summary).toBe('mentioning RSA libraries in smartcards');
		expect(node.typeToken).toBe('document');
	});

	it('retracted flag is carried from the resolver into the NodeVM', async () => {
		const prod = product(1);
		const deletion: NostrEvent = {
			id: hexId(99),
			pubkey: PUBKEY,
			sig: SIG,
			kind: 5,
			created_at: 1785549999,
			tags: [['e', prod.id]],
			content: ''
		};

		const { call } = fakeLLM(JSON.stringify({ nodes: [{ title: 'M7794', typeToken: 'smartcard' }] }));
		const res = await batchNodeInterpret({ events: [prod, deletion], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[0];
		expect(node.retracted).toBe(true);
		expect(node.status).toBe('retracted');
	});
});

/* ---------- honest per-item degrade ---------- */

describe('batchNodeInterpret — per-item degrade', () => {
	it('degrades only the schema-failing item to a skeleton and writes dead_letter', async () => {
		const good = product(1, [['identifier', 'BSI-DSZ-CC-0814-2012'], ['status', 'active']]);
		const badEvent = product(2);
		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [
					{ title: 'M7794 A2', typeToken: 'smartcard' },
					// identifier >50 chars → zod violation (title is repair-clipped, so it cannot trip the schema)
					{ title: 'Bad', typeToken: 'smartcard', identifier: 'X'.repeat(60) }
				]
			})
		);

		const res = await batchNodeInterpret({ events: [good, badEvent], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const [kept, degraded] = res.result.nodes;
		expect(kept.title).toBe('M7794 A2');
		expect(kept.typeToken).toBe('smartcard');
		expect(ProductNodeVMSchema.safeParse(degraded).success).toBe(true);
		expect(degraded.typeToken).toBe('unknown');
		expect(degraded.status).toBe('unknown');

		const rows = deadLetterRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].entityId).toBe(badEvent.id);
		expect(rows[0].reason).toContain('node validation failed');
	});

	it('extrapolatory unknown-summary is quote-gated: degrade + dead_letter', async () => {
		const note = plainEvent(1, 'Short unparseable relay note.');
		const { call } = fakeLLM(
			JSON.stringify({
				nodes: [{ title: 'Note', typeToken: 'document', summary: 'A fabricated sentence nowhere near the content.' }]
			})
		);

		const res = await batchNodeInterpret({ events: [note], graphContext: CTX, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const node = res.result.nodes[0];
		if (node.kind !== 'unknown') throw new Error('expected unknown');
		// Degraded: summary is the content clip, not the fabricated sentence.
		expect(node.summary).toBe('Short unparseable relay note.');
		const rows = deadLetterRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].reason).toContain('summary extrapolatory');
	});

	it('LLM failure degrades honestly as an error envelope (no fabricated nodes)', async () => {
		const failing: CallLLM = async () => {
			throw new TypeError('fetch failed');
		};
		const res = await batchNodeInterpret({ events: [product(1)], graphContext: CTX, provider: PROVIDER, callLLM: failing });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('unreachable');
	});
});

/* ---------- batch discipline ---------- */

describe('batchNodeInterpret — batching', () => {
	it('pages BATCH_SIZE+2 events into exactly 2 LLM calls and preserves order', async () => {
		const n = BATCH_SIZE + 2; // 14
		const events = Array.from({ length: n }, (_, i) => product(i + 1));
		const page = JSON.stringify({
			nodes: Array.from({ length: BATCH_SIZE }, () => ({ title: 'M', typeToken: 'smartcard' }))
		});
		const { call, calls } = fakeLLM(page);
		const res = await batchNodeInterpret({ events, graphContext: CTX, provider: PROVIDER, callLLM: call });

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(calls).toHaveLength(2);
		expect(res.result.nodes).toHaveLength(n);
		for (let i = 0; i < n; i++) {
			expect(res.result.nodes[i].entityId).toBe(events[i].id);
		}
	});
});
