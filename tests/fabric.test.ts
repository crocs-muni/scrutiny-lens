/**
 * W2 fabric seam tests.
 *
 * PRODUCT, METADATA and BINDING below are REAL relay events, copied verbatim
 * from the published SCRUTINY Fabric corpus at
 * scrutiny-fabric-tools/investigations/browser-memory/events-full.json
 * (172,430 events; Common Criteria data from commoncriteriaportal.org mapped
 * onto the fabric protocol by tools/browser-memory/generate-corpus.mjs in the
 * same repo). They form a connected cluster: BINDING references PRODUCT as
 * `root` and METADATA as `link`.
 *
 * Known corpus property: published ids do NOT recompute under NIP-01 (the
 * generator assigned ids), which the admitEvent gate below proves itself
 * against — admitEvent must reject these events, while the protocol-level
 * validateAndClassify/resolveGraph accept them (id recompute is not part of
 * core's `validateEvent`).
 */
import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { fencePatchPayload } from '@scrutiny-fabric/core';
import {
	admitBatch,
	admitDeletion,
	admitEvent,
	resolveGraph,
	validateAndClassify,
	type NostrEvent
} from '$lib/fabric';

const PUBKEY = '8703287e3aa93514c328e3b18431d2d7d83938e7fd9b6782b741af70a48bdcf7';

const PRODUCT: NostrEvent = {
	id: '619d169a4b26f130519b22b906fe40b9465863d4cc99ed186898b0ddcb377b23',
	pubkey: PUBKEY,
	sig: 'ba8ef003e14311a409c6ba09b752a5a4ee81de869f9dcdfebaf4464df4d260a4d3aa9de0839d7e93627d661030be0e9340842e32b72e42facbe5664d41b23c27',
	kind: 1,
	created_at: 1785542440,
	tags: [
		['t', 'scrutiny-fabric'],
		['t', 'scrutiny-product'],
		['t', 'scrutiny-v0.8.0'],
		['i', 'cc-pp:KECS-PP-1348-2025_PP_EN'],
		['k', 'cc-pp']
	],
	content:
		'Protection Profile: KECS-PP-1348-2025_PP_EN\n' +
		'Source: https://www.commoncriteriaportal.org/nfs/ccpfiles/files/ppfiles/KECS-PP-1348-2025_PP_EN.pdf'
};

const METADATA: NostrEvent = {
	id: 'e8d23a576a4edb9a92d3a36a507f546ab7acf316b1d56bd1049dbc9f559da168',
	pubkey: PUBKEY,
	sig: '937c2141cc773cbd3d0f195972afa7fce945fd95eecbfba9388998f5f94dd7a880b68030d2aa3bcddf9cf7e150f2164b74a05adafea395af27d5100bd0ca320d',
	kind: 1,
	created_at: 1785542682,
	tags: [
		['t', 'scrutiny-fabric'],
		['t', 'scrutiny-metadata'],
		['t', 'scrutiny-v0.8.0']
	],
	content: 'Claims conformance to protection profile: KECS-PP-1348-2025_PP_EN.'
};

const BINDING: NostrEvent = {
	id: '116ff0bc175156ebce8afc44fdd27409a1fe28a372ad199bcabfd6f11572049c',
	pubkey: PUBKEY,
	sig: '875f7c4a6f0a2b65939129c1343713b0ba051c16a0d8a1376d6cd4c8fe695bfb5f06bd822f4f2839d78166c21b524468a68bf8f26b9a730c6ed7873e951b80db',
	kind: 1,
	created_at: 1785542683,
	tags: [
		['t', 'scrutiny-fabric'],
		['t', 'scrutiny-binding'],
		['t', 'scrutiny-v0.8.0'],
		['e', PRODUCT.id, '', 'root', PUBKEY],
		['e', METADATA.id, '', 'link', PUBKEY]
	],
	content: 'PP conformance edge.'
};

/** Synthetic NIP-09 deletion (kind-5) honouring METADATA: same pubkey, e-tag. */
function deletionOf(target: NostrEvent, overrides?: Partial<NostrEvent>): NostrEvent {
	return {
		id: 'd'.repeat(64),
		pubkey: target.pubkey,
		sig: '0'.repeat(128),
		created_at: target.created_at + 100,
		kind: 5,
		tags: [['e', target.id]],
		content: '',
		...overrides
	};
}

/** Synthetic genuinely-signed product for the admitEvent gate: real key, real
 * schnorr sig, and a NIP-01 id that recomputes (nostr-tools finalizeEvent). */
function selfConsistentProduct(): NostrEvent {
	return finalizeEvent(
		{
			kind: 1,
			created_at: 1720000000,
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-product'],
				['t', 'scrutiny-v0.8.1']
			],
			content: 'Widget X certificate'
		},
		generateSecretKey()
	);
}

describe('validateAndClassify (real signed corpus)', () => {
	it('passes a real product/metadata/binding cluster as valid', () => {
		const { valid, invalid } = validateAndClassify([PRODUCT, METADATA, BINDING]);
		expect(invalid).toEqual([]);
		expect(valid.map((e) => e.id).sort()).toEqual(
			[PRODUCT.id, METADATA.id, BINDING.id].sort()
		);
	});

	it('flags a fabric-less plain note as invalid (not-scrutiny, not a protocol error)', () => {
		const plain: NostrEvent = {
			id: 'c'.repeat(64),
			pubkey: PUBKEY,
			sig: '0'.repeat(128),
			created_at: 1720000000,
			kind: 1,
			tags: [],
			content: 'just a nostr note'
		};
		const { valid, invalid } = validateAndClassify([plain]);
		expect(valid).toEqual([]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0].reason).toMatch(/not a SCRUTINY fabric event/);
	});

	it('flags an event with a wrong/fabric-less t-tag vocabulary as invalid', () => {
		const wrongType: NostrEvent = { ...PRODUCT, tags: [PRODUCT.tags[0], PRODUCT.tags[2]] };
		// fabric tag + version tag, but no product/metadata/binding/patch t-tag
		const { valid, invalid } = validateAndClassify([wrongType]);
		expect(valid).toEqual([]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0].event.id).toBe(PRODUCT.id);
	});

	it('names core rule ids and messages in rejection reasons instead of hiding them', () => {
		const noVersion: NostrEvent = {
			...PRODUCT,
			tags: PRODUCT.tags.filter((t) => t[1] !== 'scrutiny-v0.8.0')
		};
		const { invalid } = validateAndClassify([noVersion]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0].reason).toMatch(/TAG-2/);
		expect(invalid[0].reason).toMatch(/version/);
	});

	it('rejects a binding whose endpoints are absent as pending, naming the awaited ids', () => {
		const { valid, invalid } = validateAndClassify([BINDING]);
		expect(valid).toEqual([]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0].reason).toContain('awaiting');
		expect(invalid[0].reason).toContain(PRODUCT.id);
		expect(invalid[0].reason).toContain(METADATA.id);
	});
});

describe('admitEvent (hash-injected integrity gate)', () => {
	it('admits a synthetic NIP-01 self-consistent fabric event', () => {
		const event = selfConsistentProduct();
		expect(admitEvent(event)).toEqual({ ok: true, type: 'product' });
	});

	it('rejects a tampered event whose id no longer recomputes', () => {
		const tampered: NostrEvent = {
			...selfConsistentProduct(),
			content: 'Forged content after signing'
		};
		const result = admitEvent(tampered);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/id does not match/);
	});

	it('rejects the real corpus events: their published ids are generator artifacts', () => {
		const result = admitEvent(PRODUCT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/id does not match/);
	});

	it('rejects malformed wire shape with our own (zod) reason, not a core verdict', () => {
		const malformed = { ...PRODUCT, sig: 'not-hex' } as NostrEvent;
		const result = admitEvent(malformed);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/malformed event: sig/);
	});
});

/** Genuinely-signed kind-5: NIP-09 deletions carry no scrutiny-fabric tags
 * (§3.2), so admitEvent's SCRUTINY validity project must never see them —
 * only the structural + id-recompute halves. */
function selfConsistentDeletion(targetId: string): NostrEvent {
	return finalizeEvent(
		{ kind: 5, created_at: 1720000100, tags: [['e', targetId]], content: '' },
		generateSecretKey()
	);
}

describe('admitDeletion (kind-5 traversal gate, §3.2 / lens #68)', () => {
	it('admits a self-consistent kind-5 deletion with no SCRUTINY tags', () => {
		expect(admitDeletion(selfConsistentDeletion(PRODUCT.id))).toEqual({ ok: true });
	});

	it('rejects a kind-1 event even when otherwise self-consistent', () => {
		const result = admitDeletion(selfConsistentProduct());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/expected kind 5/);
	});

	it('rejects a tampered kind-5 whose id no longer recomputes', () => {
		const tampered: NostrEvent = {
			...selfConsistentDeletion(PRODUCT.id),
			tags: [['e', METADATA.id]]
		};
		const result = admitDeletion(tampered);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/id does not match/);
	});
});

describe('admitBatch (§8.2 traversal admission, lens #68)', () => {
	/** One author key for the whole chain: root-author patches are the
	 * canonical-chain shape, and finalizeEvent gives every event a
	 * NIP-01-recomputing id (the tamper gate admits them). */
	const AUTHOR_KEY = generateSecretKey();

	function productRoot(): NostrEvent {
		return finalizeEvent(
			{
				kind: 1,
				created_at: 1720000000,
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-product'],
					['t', 'scrutiny-v0.8.1']
				],
				content: 'Widget X certificate'
			},
			AUTHOR_KEY
		);
	}

	function chainPatch(rootId: string, parentId: string, seq: number): NostrEvent {
		return finalizeEvent(
			{
				kind: 1,
				created_at: 1720000000 + seq,
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-v0.8.1'],
					['t', 'scrutiny-patch'],
					['e', rootId, '', 'root', ''],
					['e', parentId, '', 'reply', '']
				],
				content: fencePatchPayload(`--- a/content\n+++ b/content\n@@ -1 +1 @@\n-v${seq}\n+v${seq + 1}\n`)
			},
			AUTHOR_KEY
		);
	}

	it('admits a whole chain whose root is in the batch — the exact case per-event admission drops', () => {
		const root = productRoot();
		const p1 = chainPatch(root.id, root.id, 1);
		const p2 = chainPatch(root.id, p1.id, 2);

		// The P1-shaped trap: without a lookup backing, core holds EVERY
		// patch pending (UR-2), and admitEvent's gate is 'pending'-proof.
		expect(admitEvent(p1).ok).toBe(false);

		expect(admitBatch([root], [p1, p2])).toEqual([p1, p2]);
	});

	it('excludes a patch whose root is absent from the batch (pending, not admitted)', () => {
		const root = productRoot();
		const p1 = chainPatch(root.id, root.id, 1);
		expect(admitBatch([], [p1])).toEqual([]);
	});

	it('admits kind-5 deletions of batch events alongside patches', () => {
		const root = productRoot();
		const p1 = chainPatch(root.id, root.id, 1);
		const retraction = selfConsistentDeletion(p1.id);
		expect(admitBatch([root], [p1, retraction])).toEqual([p1, retraction]);
	});

	it('excludes tampered events and candidates already in the batch', () => {
		const root = productRoot();
		const p1 = chainPatch(root.id, root.id, 1);
		const tampered: NostrEvent = {
			...p1,
			content: fencePatchPayload('--- a/content\n+++ b/content\n@@ -1 +1 @@\n-v1\n+V2\n')
		};
		expect(admitBatch([root, p1], [p1, tampered])).toEqual([]);
	});

	it('excludes non-SCRUTINY kind-1 junk the relay answered with', () => {
		const root = productRoot();
		const junk = finalizeEvent(
			{ kind: 1, created_at: 1720000009, tags: [['e', root.id, '', 'reply', '']], content: 'hi' },
			AUTHOR_KEY
		);
		expect(admitBatch([root], [junk])).toEqual([]);
	});
});

describe('resolveGraph (docs/types.md mapping)', () => {
	it('maps products/metadata to nodes and bindings to Metadata → Product edges', () => {
		const view = resolveGraph([PRODUCT, METADATA, BINDING]);
		expect(view.nodes).toHaveLength(2);
		const byId = new Map(view.nodes.map((n) => [n.id, n]));
		expect(byId.get(PRODUCT.id)?.type).toBe('product');
		expect(byId.get(METADATA.id)?.type).toBe('metadata');
		expect(view.nodes.every((n) => !n.retracted)).toBe(true);
		expect(byId.get(PRODUCT.id)?.event).toBe(PRODUCT);

		expect(view.edges).toHaveLength(1);
		expect(view.edges[0]).toEqual({
			id: BINDING.id,
			source: METADATA.id,
			target: PRODUCT.id,
			label: 'PP conformance edge.'
		});
	});

	it('marks honoured kind-5 deletion targets retracted; the deletion itself is not a node', () => {
		const view = resolveGraph([PRODUCT, METADATA, BINDING, deletionOf(METADATA)]);
		expect(view.nodes).toHaveLength(2);
		const metadata = view.nodes.find((n) => n.id === METADATA.id);
		const product = view.nodes.find((n) => n.id === PRODUCT.id);
		expect(metadata?.retracted).toBe(true);
		expect(product?.retracted).toBe(false);
		expect(view.nodes.some((n) => n.event.kind === 5)).toBe(false);
	});

	it('ignores deletions from a different author (NIP-09 authorship)', () => {
		const foreign = deletionOf(METADATA, { pubkey: 'f'.repeat(64) });
		const view = resolveGraph([PRODUCT, METADATA, BINDING, foreign]);
		expect(view.nodes.find((n) => n.id === METADATA.id)?.retracted).toBe(false);
	});

	it('drops edges whose endpoints are not both present in the batch', () => {
		const view = resolveGraph([PRODUCT, BINDING]);
		expect(view.nodes.map((n) => n.id)).toEqual([PRODUCT.id]);
		expect(view.edges).toEqual([]);
	});
});
