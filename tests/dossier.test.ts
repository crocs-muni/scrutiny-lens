// Dossier derivation contract (issue #29a): the drawer's data layer must be
// deterministic over the admitted store — resolve() is the sole patch source
// (AGENTS.md hard rule), titles are cache-first with the card's exact rule-5
// fallback, the retraction pill row is protocol truth, and unknown i-prefixes
// pass through opaque (IR-4). AI never speaks here: the module takes no AI
// seam, so these tests are the §2 rule-1 conformance assertion for the
// drawer.

import { describe, expect, it } from 'vitest';
import {
	DELETION_KIND,
	buildBinding,
	buildPatch,
	buildProduct,
	fencePatchPayload,
	type UnsignedEvent
} from '@scrutiny-fabric/core';
import { deriveDossier } from '$lib/dossier';
import type { NostrEvent } from '$lib/fabric';
import type { ProductCard } from '$lib/pipeline/cards';

const AUTHOR = 'aa'.repeat(32);
const FOREIGN = 'bb'.repeat(32);

let seq = 0;
/** Builders return unsigned templates (D13) — tests mint throwaway ids. */
function signed(template: UnsignedEvent, pubkey = AUTHOR, id?: string): NostrEvent {
	return {
		id: id ?? `ev${(seq++).toString().padStart(4, '0')}`,
		pubkey,
		created_at: template.created_at,
		kind: template.kind,
		tags: template.tags as string[][],
		content: template.content,
		sig: '00'.repeat(64)
	};
}

function productRoot(content: string, indexers: string[] = [], id?: string): NostrEvent {
	return signed(buildProduct(content, 1000, indexers).template, AUTHOR, id ?? 'root');
}

function patchEvent(
	rootId: string,
	parentId: string,
	before: string,
	after: string,
	createdAt: number,
	pubkey = AUTHOR,
	id?: string
): NostrEvent {
	return signed(
		buildPatch({
			root: { id: rootId },
			reply: { id: parentId },
			before,
			after,
			createdAt
		}).template,
		pubkey,
		id
	);
}

function cardFor(event: NostrEvent, overrides: Partial<ProductCard> = {}): ProductCard {
	return {
		id: event.id,
		typeTag: 'scrutiny-product',
		createdAt: event.created_at,
		pubkey: event.pubkey,
		title: 'AI title',
		snippet: 'AI description',
		identifiers: [],
		retracted: false,
		boundMetadata: 0,
		files: 0,
		updates: 0,
		contentStart: event.content.slice(0, 200),
		interpreted: true,
		...overrides
	};
}

describe('resolve() is the sole patch source', () => {
	it('resolves content and chain rows through core, positions in order', () => {
		const root = productRoot('v1\n', [], 'root');
		const p1 = patchEvent('root', 'root', 'v1\n', 'v2\n', 2000, AUTHOR, 'p1');
		const p2 = patchEvent('root', 'p1', 'v2\n', 'v3\n', 3000, AUTHOR, 'p2');
		const d = deriveDossier('root', [root, p1, p2], [])!;
		expect(d.content.text).toBe('v3\n');
		expect(d.content.banner).toBeNull();
		expect(d.history.map((r) => [r.position, r.state])).toEqual([
			[0, 'root'],
			[1, 'applied'],
			[2, 'applied']
		]);
		// §2 rule 2: the count equals the rows rendered.
		expect(d.counts.history).toBe(d.history.length);
	});

	it('a halted chain freezes content and says so — never finished prose', () => {
		const root = productRoot('v1\n', [], 'root');
		const p1 = patchEvent('root', 'root', 'v1\n', 'v2\n', 2000, AUTHOR, 'p1');
		// Real H1 halt (T1 no-match): a well-formed diff against the wrong
		// baseline — the chain content at that point is 'v2\n', not 'other\n'.
		// (A payload-less patch is a protocol no-op that APPLIES; a missing
		// fence is not a halt.)
		const broken = signed(
			{
				kind: p1.kind,
				created_at: 3000,
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-v0.8.1'],
					['t', 'scrutiny-patch'],
					['e', 'root', '', 'root'],
					['e', 'p1', '', 'reply']
				],
				content: fencePatchPayload('--- a\n+++ b\n@@ -1 +1 @@\n-other\n+more\n')
			},
			AUTHOR,
			'p2'
		);
		const d = deriveDossier('root', [root, p1, broken], [])!;
		expect(d.content.text).toBe('v2\n');
		expect(d.content.banner).toContain('halted after 1 patch');
		expect(d.content.banner).not.toContain('stopped at limit');
		expect(d.history.map((r) => r.state)).toEqual(['root', 'applied', 'halted-here']);
	});

	it('a self-fork freezes at the shared parent; branches are non-canonical', () => {
		const root = productRoot('v1\n', [], 'root');
		const b1 = patchEvent('root', 'root', 'v1\n', 'left\n', 2000, AUTHOR, 'b1');
		const b2 = patchEvent('root', 'root', 'v1\n', 'right\n', 3000, AUTHOR, 'b2');
		const d = deriveDossier('root', [root, b1, b2], [])!;
		expect(d.content.banner).toContain('forked');
		expect(d.content.text).toBe('v1\n');
		const parent = d.history.find((r) => r.state === 'fork-parent');
		expect(parent?.id).toBe('root');
		const branches = d.history.filter((r) => r.state === 'fork-branch');
		expect(branches).toHaveLength(2);
		expect(branches.every((r) => !r.canonical)).toBe(true);
	});
});

describe('cache-first title (never a drawer-private alternate)', () => {
	it('cache hit: the interpreted card title, sans-flagged', () => {
		const root = productRoot('raw content words here\n', ['cpe:2.3:h:x'], 'root');
		const d = deriveDossier('root', [root], [cardFor(root)])!;
		expect(d.title).toEqual({ text: 'AI title', interpreted: true });
		expect(d.snippet).toBe('AI description');
	});

	it('cache miss: the exact rule-5 the card shows — first i-tag', () => {
		const root = productRoot('raw content words here\n', ['cpe:2.3:h:x', 'cve:CVE-1'], 'root');
		const d = deriveDossier('root', [root], [])!;
		expect(d.title).toEqual({ text: 'cpe:2.3:h:x', interpreted: false });
		expect(d.snippet).toBeUndefined();
	});

	it('uninterpreted card in cache still yields the rule-5 title', () => {
		const root = productRoot('first five words of the content body\n', [], 'root');
		const d = deriveDossier('root', [root], [cardFor(root, { interpreted: false })])!;
		expect(d.title).toEqual({ text: 'first five words of the', interpreted: false });
	});

	it('unknown i-prefix passes through opaque (IR-4), verbatim in Summary', () => {
		const root = productRoot('x\n', ['zz9:opaque-namespace-value'], 'root');
		const d = deriveDossier('root', [root], [])!;
		expect(d.identifiers).toContain('zz9:opaque-namespace-value');
		expect(d.counts.summary).toBe(d.identifiers.length);
	});
});

describe('retraction is protocol truth, not presentation', () => {
	it('honoured kind-5: red-pill subject plus its own History row', () => {
		const root = productRoot('v1\n', [], 'root');
		const deletion = signed(
			{
				kind: DELETION_KIND,
				created_at: 4000,
				tags: [['e', 'root']],
				content: 'withdrawn'
			},
			AUTHOR,
			'del'
		);
		const d = deriveDossier('root', [root, deletion], [])!;
		expect(d.retracted).toBe(true);
		const row = d.history.find((r) => r.state === 'retraction');
		expect(row?.id).toBe('del');
	});

	it('foreign-author kind-5 is not honoured (DEL-1) — no pill, no row', () => {
		const root = productRoot('v1\n', [], 'root');
		const deletion = signed(
			{ kind: DELETION_KIND, created_at: 4000, tags: [['e', 'root']], content: '' },
			FOREIGN,
			'del'
		);
		const d = deriveDossier('root', [root, deletion], [])!;
		expect(d.retracted).toBe(false);
		expect(d.history.some((r) => r.state === 'retraction')).toBe(false);
	});
});

describe('files rows mirror the seam edge semantics', () => {
	it('product dossier: arrowhead at the subject, verb from binding content', () => {
		const root = productRoot('prod\n', [], 'root');
		const meta = signed(
			{
				kind: root.kind,
				created_at: 1500,
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-v0.8.1'],
					['t', 'scrutiny-metadata'],
					['i', 'cert:BSI-1']
				],
				content: 'Certification Report PDF https://x.test/r.pdf'
			},
			AUTHOR,
			'meta1'
		);
		const binding = signed(
			buildBinding({ id: 'root' }, { id: 'meta1' }, 'documents', 1600).template,
			AUTHOR,
			'bind1'
		);
		const d = deriveDossier('root', [root, meta, binding], [])!;
		expect(d.files).toHaveLength(1);
		expect(d.files[0].verb).toBe('documents');
		expect(d.files[0].destination).toBe('subject');
		expect(d.files[0].counterpartyId).toBe('meta1');
		expect(d.counts.files).toBe(1);

		// …and the metadata dossier sees the same binding from the other end.
		const m = deriveDossier('meta1', [root, meta, binding], [])!;
		expect(m.subjectType).toBe('metadata');
		expect(m.files[0].destination).toBe('counterparty');
		expect(m.files[0].counterpartyLabel).toBe('prod');
	});

	it('foreign overlay lands non-canonical with its §7.3 state word', () => {
		const root = productRoot('v1\n', [], 'root');
		const overlay = patchEvent('root', 'root', 'v1\n', 'hostile\n', 2000, FOREIGN, 'ov1');
		const d = deriveDossier('root', [root, overlay], [])!;
		expect(d.content.text).toBe('v1\n');
		const row = d.history.find((r) => r.state === 'overlay');
		expect(row).toBeDefined();
		expect(row?.canonical).toBe(false);
		expect(['clean', 'conflict', 'stale', 'orphaned', 'unclassified']).toContain(
			row?.overlayState
		);
	});
});

describe('store-level honesty guards', () => {
	it('subjects outside the admitted set have no dossier at all', () => {
		expect(deriveDossier('ghost', [], [])).toBeNull();
	});

	it('binding endpoints outside the batch render as bare ids, never labels', () => {
		const root = productRoot('prod\n', [], 'root');
		const binding = signed(
			buildBinding({ id: 'root' }, { id: 'absent-meta' }, 'documents', 1600).template,
			AUTHOR,
			'bind1'
		);
		const d = deriveDossier('root', [root, binding], [])!;
		expect(d.files[0].counterpartyLabel).toBeNull();
	});
});
