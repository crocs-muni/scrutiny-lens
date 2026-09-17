import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { subjectGrounding } from '../src/lib/fabric';
import type { NostrEvent } from '../src/lib/fabric';

function ev(tags: string[][], content: string, kind = 1): NostrEvent {
	return finalizeEvent({ kind, tags, content, created_at: 1700000000 }, generateSecretKey()) as NostrEvent;
}

/** Canonical-tagged fixtures: product/meta/binding/patch/deletion leg per card. */
function cohort(cardTag: string) {
	const product = ev(
		[['i', `cve:CVE-2024-${cardTag}`], ['k', 'cve'], ['t', 'scrutiny-fabric'], ['t', 'scrutiny-v0.8.1'], ['t', 'scrutiny-product']],
		`product ${cardTag}`
	);
	const meta = ev(
		[['i', `cve:CVE-2024-${cardTag}`], ['k', 'cve'], ['t', 'scrutiny-fabric'], ['t', 'scrutiny-v0.8.1'], ['t', 'scrutiny-metadata']],
		`metadata ${cardTag}`
	);
	const binding = ev(
		[
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-binding'],
			['e', product.id, '', 'root', ''],
			['e', meta.id, '', 'link', '']
		],
		`binding ${cardTag}`
	);
	const patch = ev(
		[
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', 'scrutiny-patch'],
			['e', product.id, '', 'root', ''],
			['e', product.id, '', 'reply', '']
		],
		`--- content ${cardTag}`
	);
	return { product, meta, binding, patch };
}

describe('subjectGrounding — the events inside the open card', () => {
	it('returns the node, its one-hop neighbors, the binding, and the patches', () => {
		const a = cohort('1000');
		const b = cohort('2000');
		const admitted: NostrEvent[] = [a.product, b.product, b.meta, b.binding, a.meta, a.binding, a.patch];
		const got = subjectGrounding(admitted, a.product.id).map((e) => e.id);
		for (const e of [a.product, a.meta, a.binding, a.patch]) {
			expect(got).toContain(e.id);
		}
		for (const e of [b.product, b.meta, b.binding]) {
			expect(got).not.toContain(e.id);
		}
	});

	it('selected metadata centers the same card (its product joins via the edge)', () => {
		const a = cohort('1000');
		const admitted: NostrEvent[] = [a.product, a.meta, a.binding, a.patch];
		const got = subjectGrounding(admitted, a.meta.id).map((e) => e.id);
		expect(got).toContain(a.product.id);
		expect(got).toContain(a.meta.id);
		expect(got).toContain(a.binding.id);
		expect(got).toContain(a.patch.id);
	});

	it('honoured kind-5 deletion of an adjacent node rides along', () => {
		const a = cohort('1000');
		const sk = generateSecretKey();
		const reissue = (e: NostrEvent): NostrEvent =>
			finalizeEvent({ kind: DELETION, tags: [['e', e.id]], content: 'retracted', created_at: 1700000001 }, sk) as NostrEvent;
		const DELETION = 5;
		const deletion = reissue(a.meta);
		const admitted: NostrEvent[] = [a.product, a.meta, a.binding, deletion];
		const got = subjectGrounding(admitted, a.product.id).map((e) => e.id);
		expect(got).toContain(deletion.id);
	});

	it('non-node selection grounds nothing (honest UNGROUNDED fallback)', () => {
		const a = cohort('1000');
		expect(subjectGrounding([a.product, a.meta, a.binding], 'not-a-node')).toHaveLength(0);
	});
});
