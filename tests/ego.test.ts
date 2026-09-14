// Ego-graph trust gate (issue #29b): the canvas derivation is deterministic
// over the admitted store — positions computable from protocol data only,
// badges counting exactly what placement hides, retraction honored per the
// honoured-deletion rule, and chain words verbatim from core resolve().
// AI never speaks here: ego.ts takes no AI seam, so this file is the
// conformance assertion for the canvas slice's data contract.

import { describe, expect, it } from 'vitest';
import {
	buildBinding,
	buildMetadata,
	buildPatch,
	buildProduct,
	type UnsignedEvent
} from '@scrutiny-fabric/core';
import { deriveEgo, sideToward, chainWordOf } from '$lib/graph/ego';
import type { NostrEvent } from '$lib/fabric';
import type { ProductCard } from '$lib/pipeline/cards';

const AUTHOR = 'aa'.repeat(32);

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

function product(content: string, createdAt: number, indexers: string[] = [], id?: string) {
	return signed(buildProduct(content, createdAt, indexers).template, AUTHOR, id);
}
function metadata(content: string, createdAt: number, indexers: string[] = [], id?: string) {
	return signed(buildMetadata(content, createdAt, indexers).template, AUTHOR, id);
}
function binding(rootId: string, linkId: string, verb: string, createdAt: number, id?: string) {
	return signed(buildBinding({ id: rootId }, { id: linkId }, verb, createdAt).template, AUTHOR, id);
}
function patch(rootId: string, parentId: string, before: string, after: string, createdAt: number, id?: string) {
	return signed(
		buildPatch({ root: { id: rootId }, reply: { id: parentId }, before, after, createdAt }).template,
		AUTHOR,
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

const NO_EXPAND = new Set<string>();

/** base ego fixture: root with two metadata spokes (distinct verbs) — m1
 * carries the URL (files=1), m1 also bridges to shadow product p2, p2's
 * own m2 stays hidden behind the badge. */
function baseFixture() {
	const root = product('root content\n', 1000, ['cve:CVE-2017-15361'], 'root');
	const m1 = metadata('CVE-2017-15361 advisory https://x.test/a.pdf', 1100, ['cve:CVE-2017-15361'], 'm1');
	const m3 = metadata('Security Target document', 1200, ['st:ST-1'], 'm3');
	const p2 = product('second product\n', 1300, ['cpe:2.3:h:nxp:jcop4'], 'p2');
	const m2 = metadata('Maintenance report, no links', 1400, [], 'm2');
	const b1 = binding('root', 'm1', 'affected by', 1500, 'b1');
	const b3 = binding('root', 'm3', 'documents', 1600, 'b3');
	const b2 = binding('p2', 'm1', 'affects', 1700, 'b2');
	const b4 = binding('p2', 'm2', 'documents', 1800, 'b4');
	return { root, m1, m3, p2, m2, b1, b3, b2, b4 };
}

describe('deriveEgo — placement', () => {
	it('centers the root; spokes orbit on verb→time→id order at deterministic positions', () => {
		const f = baseFixture();
		const events = [f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4];
		const opts = { showDeleted: false, expanded: NO_EXPAND, cards: [] };
		const a = deriveEgo(events, 'root', opts);
		const b = deriveEgo([...events].reverse(), 'root', opts);
		// Input order must not influence the view (determinism).
		expect(a).toEqual(b);

		const root = a.nodes.find((n) => n.id === 'root');
		expect(root).toMatchObject({ role: 'root', kind: 'product', x: 0, y: 0 });
		// verbs sort 'affected by' before 'documents' → m1 takes index 0
		// (start EAST so the spread fills the wide canvas).
		const m1 = a.nodes.find((n) => n.id === 'm1');
		const m3 = a.nodes.find((n) => n.id === 'm3');
		expect(m1?.x).toBeCloseTo(210, 5);
		expect(m1?.y).toBeCloseTo(0, 5);
		expect(m3?.x).toBeCloseTo(-210, 5);
		expect(m3?.y).toBeCloseTo(0, 5);
	});

	it('routes edges Metadata → Product with the verb label and facing handles', () => {
		const f = baseFixture();
		const view = deriveEgo([f.root, f.m1, f.b1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.edges).toHaveLength(1);
		const edge = view.edges[0];
		expect(edge).toMatchObject({ source: 'm1', target: 'root', label: 'affected by', shadowed: false });
		// m1 sits east of the root → the edge leaves m1's left, enters root's right.
		expect(edge.sourceHandle).toBe('left');
		expect(edge.targetHandle).toBe('right');
		expect(sideToward(0, 5)).toBe('bottom');
		expect(sideToward(0, -5)).toBe('top');
		expect(sideToward(9, 1)).toBe('right');
		expect(sideToward(-9, 1)).toBe('left');
	});

	it('an absent root (or a non-node event) yields an empty view — the canvas', () => {
		const f = baseFixture();
		expect(deriveEgo([f.root], 'ghost', { showDeleted: false, expanded: NO_EXPAND, cards: [] })).toEqual({ nodes: [], edges: [] });
		expect(deriveEgo([f.root, f.b1], 'b1', { showDeleted: false, expanded: NO_EXPAND, cards: [] })).toEqual({ nodes: [], edges: [] });
	});
});

describe('deriveEgo — shadows and expansion (ruling 8)', () => {
	it('shared metadata exposes the other end as a shadow hub with a hidden-neighbor badge; the edge stays', () => {
		const f = baseFixture();
		const view = deriveEgo([f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		const p2 = view.nodes.find((n) => n.id === 'p2');
		expect(p2).toBeDefined();
		expect(p2).toMatchObject({ role: 'shadow', badge: 1 }); // m2 is admitted but not placed
		// The bridge edge to the shadow renders dashed (G1 multihop ray)…
		const bridge = view.edges.find((e) => e.id === 'b2');
		expect(bridge).toMatchObject({ source: 'm1', target: 'p2', shadowed: true });
		// …but the hidden neighbor itself has no node and no edge.
		expect(view.nodes.some((n) => n.id === 'm2')).toBe(false);
		expect(view.edges.some((e) => e.id === 'b4')).toBe(false);
	});

	it('expansion promotes the shadow and fans its admitted neighbors out; the badge drains', () => {
		const f = baseFixture();
		const events = [f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4];
		const view = deriveEgo(events, 'root', {
			showDeleted: false,
			expanded: new Set(['p2']),
			cards: []
		});
		const p2 = view.nodes.find((n) => n.id === 'p2');
		expect(p2).toMatchObject({ role: 'spoke', badge: null }); // never zero-shown
		const m2 = view.nodes.find((n) => n.id === 'm2');
		expect(m2).toBeDefined();
		expect(m2?.role).toBe('spoke');
		// Fan placement continues outward along the bridge ray (east here).
		expect(m2!.x).toBeCloseTo(210 + 180 + 170, 5);
		expect(m2!.y).toBeCloseTo(0, 5);
		const leaf = view.edges.find((e) => e.id === 'b4');
		expect(leaf).toMatchObject({ source: 'm2', target: 'p2', shadowed: false });
	});

	it('a binding to a never-admitted event contributes nothing — no node, edge, or silent guess', () => {
		const f = baseFixture();
		const ghost = binding('root', 'ghost-meta', 'documents', 1900, 'b9');
		const view = deriveEgo([f.root, f.m1, f.b1, ghost], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes.map((n) => n.id)).toEqual(['root', 'm1']);
		expect(view.edges).toHaveLength(1);
		// Hub counts are dossier-parity: admitted bindings only, ghost excluded.
		expect(view.nodes[0]).toMatchObject({ boundMetadata: 1 });
	});
});

describe('deriveEgo — retraction (ruling 10)', () => {
	const DEL = (targetId: string): NostrEvent => ({
		id: `del-${targetId}`,
		pubkey: AUTHOR,
		created_at: 2000,
		kind: 5,
		tags: [['e', targetId]],
		content: '',
		sig: '00'.repeat(64)
	});

	it('honoured retractions vanish by default and return under Show deleted — edges with them', () => {
		const root = product('root\n', 1000, [], 'root');
		const mdel = metadata('deleted report', 1100, [], 'mdel');
		const alive = metadata('live note', 1200, [], 'alive');
		const bd = binding('root', 'mdel', 'documents', 1300, 'bd');
		const ba = binding('root', 'alive', 'documents', 1400, 'ba');
		const events = [root, mdel, alive, bd, ba, DEL('mdel')];
		const hidden = deriveEgo(events, 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(hidden.nodes.some((n) => n.id === 'mdel')).toBe(false);
		expect(hidden.edges.some((e) => e.id === 'bd')).toBe(false);
		const shown = deriveEgo(events, 'root', { showDeleted: true, expanded: NO_EXPAND, cards: [] });
		expect(shown.nodes.find((n) => n.id === 'mdel')).toMatchObject({ retracted: true });
		expect(shown.edges.some((e) => e.id === 'bd')).toBe(true);
	});

	it('the root always renders, retraction included — the canvas mirrors an opened dossier', () => {
		const root = product('root\n', 1000, [], 'root');
		const view = deriveEgo([root, DEL('root')], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes).toHaveLength(1);
		expect(view.nodes[0]).toMatchObject({ id: 'root', role: 'root', retracted: true });
	});
});

describe('deriveEgo — chain word and edited count (ruling 9)', () => {
	it('clean patches read plain edited ×N with no word', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2\n', 2000, 'p1');
		const p2 = patch('root', 'p1', 'v2\n', 'v3\n', 3000, 'p2');
		const view = deriveEgo([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes[0]).toMatchObject({ editedN: 2, chainWord: null });
	});

	it('a halted chain says halted', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2\n', 2000, 'p1');
		// H1 halt: a well-formed diff against the wrong base (T1 no-match).
		const p2 = patch('root', 'p1', 'WRONG\n', 'v3\n', 3000, 'p2');
		const view = deriveEgo([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes[0]).toMatchObject({ editedN: 1, chainWord: 'halted' });
	});

	it('a self-fork says forked with zero applied', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2-a\n', 2000, 'p1a');
		const p2 = patch('root', 'root', 'v1\n', 'v2-b\n', 2100, 'p1b');
		const view = deriveEgo([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes[0]).toMatchObject({ editedN: 0, chainWord: 'forked' });
	});

	it('a resource ceiling says stopped at limit — never "halted" (§5.4)', () => {
		// Disjoint changes only: 10-line gaps defeat unified-diff context
		// merging, so 80 mutations = 80 hunks → core's DEFAULT_MAX_HUNKS (64).
		const wide = Array.from({ length: 800 }, (_, i) => `keep ${i}`).join('\n') + '\n';
		const changed = wide
			.split('\n')
			.map((l, i) => (i % 10 === 0 ? `change ${i}` : l))
			.join('\n');
		const root = product(wide, 1000, [], 'root');
		const p1 = patch('root', 'root', wide, changed, 2000, 'p1');
		const res = deriveEgo([root, p1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(res.nodes[0].chainWord).toBe('stopped at limit');
	});

	it('chainWordOf maps every chain status and nothing else invents a word', () => {
		const cases = [
			[{ chain: { status: 'resolved', applied: ['a', 'b'] } }, { word: null, editedN: 2 }],
			[{ chain: { status: 'halted', applied: ['a'] } }, { word: 'halted', editedN: 1 }],
			[{ chain: { status: 'forked' } }, { word: 'forked', editedN: 0 }],
			[{ chain: { status: 'aborted', applied: [] } }, { word: 'stopped at limit', editedN: 0 }],
			[{ chain: { status: 'absent' } }, { word: null, editedN: 0 }]
		] as const;
		for (const [resolution, expected] of cases) {
			// Structural stand-in: chainWordOf reads only status + applied.length.
			expect(chainWordOf(resolution as never)).toEqual(expected);
		}
	});
});

describe('deriveEgo — node voice', () => {
	it('interpreted products take the cache title+snippet; metadata stays rule-5 mono with no snippet', () => {
		const f = baseFixture();
		const cards = [cardFor(f.root)];
		const view = deriveEgo([f.root, f.m1, f.b1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards });
		const root = view.nodes.find((n) => n.id === 'root');
		expect(root).toMatchObject({ title: 'AI title', interpreted: true, snippet: 'AI description' });
		const m1 = view.nodes.find((n) => n.id === 'm1');
		// rule-5: first i-tag value wins the fallback title.
		expect(m1).toMatchObject({ title: 'cve:CVE-2017-15361', interpreted: false, snippet: undefined });
	});

	it('hub counts scan the admitted store, not the placed subset', () => {
		const f = baseFixture();
		// m2 never placed (p2 unexpanded) — but it IS an admitted binding of p2.
		const view = deriveEgo([f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		expect(view.nodes.find((n) => n.id === 'root')).toMatchObject({ boundMetadata: 2, files: 1 });
		// p2 binds m1 (URL-bearing) and m2: dossier-parity files count is 1.
		expect(view.nodes.find((n) => n.id === 'p2')).toMatchObject({ boundMetadata: 2, files: 1 });
	});
});
