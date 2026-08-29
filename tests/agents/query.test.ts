import { describe, it, expect} from 'vitest';
import type { CallLLM, CallLLMArgs } from '$lib/ai/output';
import {
	interpretQuery,
	classifyQueryType,
	KNOWN_INDEXER_PREFIXES
} from '$lib/ai/agents/query';

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'test-key' };

/** Fake LLM returning the nth queued text per call (last one repeats). */
function fakeLLM(...texts: string[]): { call: CallLLM; calls: CallLLMArgs[] } {
	const calls: CallLLMArgs[] = [];
	const call: CallLLM = async (args) => {
		calls.push(args);
		return texts[Math.min(calls.length - 1, texts.length - 1)];
	};
	return { call, calls };
}

function throwing(message: string): CallLLM {
	return async () => {
		throw new Error(message);
	};
}

describe('interpretQuery — valid plan', () => {
	it('returns ok with validated filters, steps, and narrative', async () => {
		const { call } = fakeLLM(
			'[{"mode":"identifier","identifier":"cve:CVE-2017-15361"},{"mode":"freetext","search":"ROCA Infineon"}]'
		);
		const res = await interpretQuery({
			query: 'ROCA vulnerability in Infineon chips, see cve:CVE-2017-15361',
			profile: 'smartcard',
			provider: PROVIDER,
			callLLM: call
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const r = res.result;
		expect(r.filters).toEqual([
			{ mode: 'identifier', identifier: 'cve:CVE-2017-15361' },
			{ mode: 'freetext', search: 'ROCA Infineon' }
		]);
		expect(r.queryType).toBe('vulnerability');
		expect(
			r.steps.some(
				(s) => s.kind === 'recognized' && s.prefix === 'cve' && s.value === 'CVE-2017-15361'
			)
		).toBe(true);
		expect(r.steps.some((s) => s.kind === 'queried' && s.label.includes('ROCA Infineon'))).toBe(true);
		expect(r.interpretation).toContain('cve:CVE-2017-15361');
		expect(r.summary.length).toBeLessThanOrEqual(300);
		for (const s of r.steps) expect(s.label.length).toBeLessThanOrEqual(120);
	});

	it('exports exactly the six known indexer prefixes', () => {
		expect([...KNOWN_INDEXER_PREFIXES]).toEqual(['cc', 'cve', 'cpe', 'cwe', 'vendor', 'pp']);
	});
});

describe('interpretQuery — queryType classification', () => {
	async function typeOf(query: string, plan: string): Promise<string> {
		const { call } = fakeLLM(plan);
		const res = await interpretQuery({ query, provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error('unreachable');
		return res.result.queryType;
	}

	it('identifier form: exactly one {prefix:value} and the whole query is it', async () => {
		await expect(
			typeOf('cve:CVE-2017-15361', '[{"mode":"identifier","identifier":"cve:CVE-2017-15361"}]')
		).resolves.toBe('identifier');
	});

	it('vulnerability: query mentions a CVE', async () => {
		await expect(
			typeOf(
				'CVE-2017-15361 ROCA in Infineon chips',
				'[{"mode":"freetext","search":"Infineon ROCA"}]'
			)
		).resolves.toBe('vulnerability');
	});

	it('certificate: query mentions a certificate', async () => {
		await expect(
			typeOf(
				'CC certificate for Infineon M7794',
				'[{"mode":"freetext","search":"Infineon M7794"}]'
			)
		).resolves.toBe('certificate');
	});

	it('product: product terms without identifier/cert/cve', async () => {
		await expect(
			typeOf('Infineon M7794 smartcard', '[{"mode":"freetext","search":"Infineon M7794 smartcard"}]')
		).resolves.toBe('product');
	});

	it('base: bare keyword only', async () => {
		await expect(typeOf('smartcard', '[{"mode":"browse","types":["cc"]}]')).resolves.toBe('base');
	});

	it('direct classification matches the agent output', () => {
		expect(classifyQueryType('cve:CVE-2017-15361')).toBe('identifier');
		expect(classifyQueryType('cve-2017-15361 infineon')).toBe('vulnerability');
		expect(classifyQueryType('smartcard')).toBe('base');
	});
});

describe('interpretQuery — prefix validation', () => {
	it('rejects unknown indexer prefixes with a reason, keeps valid filters', async () => {
		const { call } = fakeLLM(
			'[{"mode":"identifier","identifier":"xyz:ABC-1"},{"mode":"identifier","identifier":"cve:CVE-2017-15361"}]'
		);
		const res = await interpretQuery({
			query: 'cve:CVE-2017-15361',
			provider: PROVIDER,
			callLLM: call
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const r = res.result;
		expect(r.filters).toEqual([{ mode: 'identifier', identifier: 'cve:CVE-2017-15361' }]);
		const rejection = r.steps.find(
			(s) => s.label.includes('xyz:ABC-1') && /Unknown indexer prefix "xyz"/.test(s.label)
		);
		expect(rejection).toBeDefined();
		expect(r.summary).toContain('xyz:ABC-1');
	});

	it('accepts unprefixed identifiers as raw identifier filters', async () => {
		const { call } = fakeLLM('[{"mode":"identifier","identifier":"CVE-2017-15361"}]');
		const res = await interpretQuery({
			query: 'CVE-2017-15361',
			provider: PROVIDER,
			callLLM: call
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.result.filters).toEqual([{ mode: 'identifier', identifier: 'CVE-2017-15361' }]);
	});

	it('falls back to a free-text filter when every planned filter is rejected', async () => {
		const { call } = fakeLLM('[{"mode":"identifier","identifier":"xyz:ABC-1"}]');
		const res = await interpretQuery({ query: 'mystery thing', provider: PROVIDER, callLLM: call });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.result.filters).toEqual([{ mode: 'freetext', search: 'mystery thing' }]);
	});
});

describe('interpretQuery — schema gate and degradation', () => {
	it('schema failure after exactly one repair retry', async () => {
		const { call, calls } = fakeLLM('not json at all', 'still not json');
		const res = await interpretQuery({
			query: 'ROCA',
			provider: PROVIDER,
			callLLM: call
		});

		expect(calls).toHaveLength(2);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('schema_failure');
	});

	it('one retry succeeds → ok (repair appended zod issue text)', async () => {
		const { call, calls } = fakeLLM(
			'garbage',
			'[{"mode":"freetext","search":"ROCA"}]'
		);
		const res = await interpretQuery({ query: 'ROCA', provider: PROVIDER, callLLM: call });
		expect(calls).toHaveLength(2);
		expect(calls[1].messages.at(-1)?.content).toContain('failed validation');
		expect(res.ok).toBe(true);
	});

	it('LLM timeout surfaces as unreachable', async () => {
		const res = await interpretQuery({
			query: 'ROCA',
			provider: PROVIDER,
			callLLM: throwing('request timed out')
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('unreachable');
	});

	it('transport failure surfaces as unreachable', async () => {
		const res = await interpretQuery({
			query: 'ROCA',
			provider: PROVIDER,
			callLLM: throwing('ECONNREFUSED')
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('unreachable');
	});

	it('no API key surfaces as no_key without calling the LLM', async () => {
		const { call, calls } = fakeLLM('[]');
		const res = await interpretQuery({ query: 'ROCA', callLLM: call });
		expect(calls).toHaveLength(0);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.kind).toBe('no_key');
	});
});
