// Subject-graph trust gate (issue #29b): the canvas derivation is
// deterministic over the admitted store — positions computable from protocol
// data only, badges counting exactly what placement hides, retraction
// honored per the honoured-deletion rule, and chain words verbatim from
// core resolve(). AI never speaks here: subject-graph.ts takes no AI seam,
// so this file is the conformance assertion for the canvas slice's data
// contract.

import { describe, expect, it } from 'vitest';
import {
	buildBinding,
	buildMetadata,
	buildPatch,
	buildProduct,
	type UnsignedEvent
} from '@scrutiny-fabric/core';
import { deriveSubjectGraph, sideToward, chainWordOf } from '$lib/graph/subject-graph';
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

/** base fixture: subject with two linked records (distinct verbs) — m1
 * carries the URL (files=1), m1 also bridges to related product p2, p2's
 * own m2 stays hidden behind the badge. */
function baseFixture() {
	const root = product('root content\n', 1000, ['cve:CVE-2017-15361'], 'root');
	// m1's artifact uses the labeled-line grammar (#77) — a mid-prose URL
	// is deliberately NOT an artifact (the advisory-homepage bug).
	const m1 = metadata('CVE-2017-15361 advisory.\nPDF: https://x.test/a.pdf', 1100, ['cve:CVE-2017-15361'], 'm1');
	const m3 = metadata('Security Target document', 1200, ['st:ST-1'], 'm3');
	const p2 = product('second product\n', 1300, ['cpe:2.3:h:nxp:jcop4'], 'p2');
	const m2 = metadata('Maintenance report, no links', 1400, [], 'm2');
	const b1 = binding('root', 'm1', 'affected by', 1500, 'b1');
	const b3 = binding('root', 'm3', 'documents', 1600, 'b3');
	const b2 = binding('p2', 'm1', 'affects', 1700, 'b2');
	const b4 = binding('p2', 'm2', 'documents', 1800, 'b4');
	return { root, m1, m3, p2, m2, b1, b3, b2, b4 };
}

describe('deriveSubjectGraph — placement', () => {
	it('centers the subject; records take dyadic slots by ADMISSION ORDER (ruling 3 append-only)', () => {
		const f = baseFixture();
		const events = [f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4];
		const opts = { showDeleted: false, expanded: NO_EXPAND, cards: [] };
		const a = deriveSubjectGraph(events, 'root', opts);

		const root = a.nodes.find((n) => n.id === 'root');
		expect(root).toMatchObject({ role: 'subject', kind: 'product', x: 0, y: 0 });
		// m1 admitted before m3 → slot 0 (EAST), slot 1 (WEST).
		const m1 = a.nodes.find((n) => n.id === 'm1');
		const m3 = a.nodes.find((n) => n.id === 'm3');
		expect(m1?.x).toBeCloseTo(252, 5);
		expect(m1?.y).toBeCloseTo(0, 5);
		expect(m3?.x).toBeCloseTo(-252, 5);
		expect(m3?.y).toBeCloseTo(0, 5);
	});

	it('prefix growth never moves a placed node — the append-only contract', () => {
		const f = baseFixture();
		const before = [f.root, f.m1, f.b1];
		const after = [f.root, f.m1, f.b1, f.m3, f.b3];
		const opts = { showDeleted: false, expanded: NO_EXPAND, cards: [] };
		const young = deriveSubjectGraph(before, 'root', opts);
		const grown = deriveSubjectGraph(after, 'root', opts);
		for (const shared of young.nodes) {
			const same = grown.nodes.find((n) => n.id === shared.id);
			expect(same, `${shared.id} moved when the store grew`).toMatchObject({ x: shared.x, y: shared.y });
		}
		// …and identical input is fully deterministic (pure module).
		expect(deriveSubjectGraph(after, 'root', opts)).toEqual(grown);
		// Slot 1's dyadic angle is π (west) — the sequence bit-reverses.
		const m3 = grown.nodes.find((n) => n.id === 'm3');
		expect(m3?.x).toBeCloseTo(-252, 5);
		expect(m3?.y).toBeCloseTo(0, 5);
	});

	it('diagonal slots move out one ring; overflow repeats the grid +1 ring', () => {
		// The collision class the owner screenshot caught: at 45° on the
		// inner ring (slot 4, chord 194px) record halves overlap 230px cards —
		// slot 4 must sit on the +180 ring; slot 8 repeats the grid +1 ring.
		const root = product('root\n', 1000, [], 'root');
		const events: NostrEvent[] = [root];
		for (let i = 0; i < 10; i++) {
			events.push(
				metadata(`meta ${i}`, 1100 + i, [], `m${i}`),
				binding('root', `m${i}`, 'documents', 1500 + i, `b${i}`)
			);
		}
		const view = deriveSubjectGraph(events, 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		// slot 4 = rev(4)=1 → 45° NE on the diagonal ring (radius 432):
		// x≈y≈432·cos45≈305.47
		const m4 = view.nodes.find((n) => n.id === 'm4');
		expect(m4?.x).toBeCloseTo(305.47, 1);
		expect(m4?.y).toBeCloseTo(305.47, 1);
		// slot 5 = rev(5)=5 → 225° SW: x≈y≈-305.47
		const m5 = view.nodes.find((n) => n.id === 'm5');
		expect(m5?.x).toBeCloseTo(-305.47, 1);
		expect(m5?.y).toBeCloseTo(-305.47, 1);
		// slot 8 = ring overflow, grid repeat +1 ring: cardinal east at 502.
		const m8 = view.nodes.find((n) => n.id === 'm8');
		expect(m8?.x).toBeCloseTo(502, 5);
		expect(m8?.y).toBeCloseTo(0, 5);
		expect(view.nodes.filter((n) => n.role === 'record')).toHaveLength(10);
	});

	it('routes edges Metadata → Product with the verb label and facing handles', () => {
		const f = baseFixture();
		const view = deriveSubjectGraph([f.root, f.m1, f.b1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.edges).toHaveLength(1);
		const edge = view.edges[0];
		expect(edge).toMatchObject({ source: 'm1', target: 'root', label: 'affected by', related: false });
		// m1 sits east of the subject → the edge leaves m1's left, enters the
		// subject's right.
		expect(edge.sourceHandle).toBe('left');
		expect(edge.targetHandle).toBe('right');
		expect(sideToward(0, 5)).toBe('bottom');
		expect(sideToward(0, -5)).toBe('top');
		expect(sideToward(9, 1)).toBe('right');
		expect(sideToward(-9, 1)).toBe('left');
	});

	it('an absent subject (or a non-node event) yields an empty view — the canvas', () => {
		const f = baseFixture();
		expect(deriveSubjectGraph([f.root], 'ghost', { showDeleted: false, expanded: NO_EXPAND, cards: [] })).toEqual({ nodes: [], edges: [] });
		expect(deriveSubjectGraph([f.root, f.b1], 'b1', { showDeleted: false, expanded: NO_EXPAND, cards: [] })).toEqual({ nodes: [], edges: [] });
	});
});

describe('deriveSubjectGraph — related products and expansion (ruling 8)', () => {
	it('a shared linked record exposes the other end as a related product with a hidden-neighbor badge; the edge stays', () => {
		const f = baseFixture();
		const view = deriveSubjectGraph([f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		const p2 = view.nodes.find((n) => n.id === 'p2');
		expect(p2).toBeDefined();
		expect(p2).toMatchObject({ role: 'related', badge: 1 }); // m2 is admitted but not placed
		// The bridge edge to the related product renders dashed (G1 multihop
		// ray)…
		const bridge = view.edges.find((e) => e.id === 'b2');
		expect(bridge).toMatchObject({ source: 'm1', target: 'p2', related: true });
		// …but the hidden neighbor itself has no node and no edge.
		expect(view.nodes.some((n) => n.id === 'm2')).toBe(false);
		expect(view.edges.some((e) => e.id === 'b4')).toBe(false);
	});

	it('expansion promotes the related product and fans its admitted records out; the badge drains', () => {
		const f = baseFixture();
		const events = [f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4];
		const view = deriveSubjectGraph(events, 'root', {
			showDeleted: false,
			expanded: new Set(['p2']),
			cards: []
		});
		const p2 = view.nodes.find((n) => n.id === 'p2');
		expect(p2).toMatchObject({ role: 'record', badge: null }); // never zero-shown
		const m2 = view.nodes.find((n) => n.id === 'm2');
		expect(m2).toBeDefined();
		expect(m2?.role).toBe('record');
		// Related product at inner-ring + one subject-width step from the
		// origin…
		const relatedP2 = view.nodes.find((n) => n.id === 'p2');
		expect(relatedP2?.x).toBeCloseTo(252 + 250, 5);
		// …and its own record one step beyond (east bridge ray).
		expect(m2!.x).toBeCloseTo(252 + 250 + 250, 5);
		expect(m2!.y).toBeCloseTo(0, 5);
		const leaf = view.edges.find((e) => e.id === 'b4');
		expect(leaf).toMatchObject({ source: 'm2', target: 'p2', related: false });
	});

	it('a binding to a never-admitted event contributes nothing — no node, edge, or silent guess', () => {
		const f = baseFixture();
		const ghost = binding('root', 'ghost-meta', 'documents', 1900, 'b9');
		const view = deriveSubjectGraph([f.root, f.m1, f.b1, ghost], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes.map((n) => n.id)).toEqual(['root', 'm1']);
		expect(view.edges).toHaveLength(1);
		// Subject counts are dossier-parity (dossier.ts fileRows): "bindings
		// referencing this event" — the ghost row counts there (it renders as
		// a bare mono id), so it counts here too.
		expect(view.nodes[0]).toMatchObject({ boundMetadata: 2 });
	});
});

describe('deriveSubjectGraph — retraction (ruling 10)', () => {
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
		const hidden = deriveSubjectGraph(events, 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(hidden.nodes.some((n) => n.id === 'mdel')).toBe(false);
		expect(hidden.edges.some((e) => e.id === 'bd')).toBe(false);
		const shown = deriveSubjectGraph(events, 'root', { showDeleted: true, expanded: NO_EXPAND, cards: [] });
		expect(shown.nodes.find((n) => n.id === 'mdel')).toMatchObject({ retracted: true });
		expect(shown.edges.some((e) => e.id === 'bd')).toBe(true);
	});

	it('the subject always renders, retraction included — the canvas mirrors an opened dossier', () => {
		const root = product('root\n', 1000, [], 'root');
		const view = deriveSubjectGraph([root, DEL('root')], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes).toHaveLength(1);
		expect(view.nodes[0]).toMatchObject({ id: 'root', role: 'subject', retracted: true });
	});
});

describe('deriveSubjectGraph — chain word and edited count (ruling 9)', () => {
	it('clean patches read plain edited ×N with no word', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2\n', 2000, 'p1');
		const p2 = patch('root', 'p1', 'v2\n', 'v3\n', 3000, 'p2');
		const view = deriveSubjectGraph([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes[0]).toMatchObject({ editedN: 2, chainWord: null });
	});

	it('a halted chain says halted', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2\n', 2000, 'p1');
		// H1 halt: a well-formed diff against the wrong base (T1 no-match).
		const p2 = patch('root', 'p1', 'WRONG\n', 'v3\n', 3000, 'p2');
		const view = deriveSubjectGraph([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
		expect(view.nodes[0]).toMatchObject({ editedN: 1, chainWord: 'halted' });
	});

	it('a self-fork says forked with zero applied', () => {
		const root = product('v1\n', 1000, [], 'root');
		const p1 = patch('root', 'root', 'v1\n', 'v2-a\n', 2000, 'p1a');
		const p2 = patch('root', 'root', 'v1\n', 'v2-b\n', 2100, 'p1b');
		const view = deriveSubjectGraph([root, p1, p2], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
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
		const res = deriveSubjectGraph([root, p1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards: [] });
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

describe('deriveSubjectGraph — node voice', () => {
	it('interpreted products take the cache title+snippet; metadata stays rule-5 mono with no snippet', () => {
		const f = baseFixture();
		const cards = [cardFor(f.root)];
		const view = deriveSubjectGraph([f.root, f.m1, f.b1], 'root', { showDeleted: false, expanded: NO_EXPAND, cards });
		const root = view.nodes.find((n) => n.id === 'root');
		expect(root).toMatchObject({ title: 'AI title', interpreted: true, snippet: 'AI description' });
		const m1 = view.nodes.find((n) => n.id === 'm1');
		// rule-5: first i-tag value wins the fallback title.
		expect(m1).toMatchObject({ title: 'cve:CVE-2017-15361', interpreted: false, snippet: undefined });
	});

	it('node tiles interpret the records and hand the icon token through; the card surface still wins on products (#29c ruling C)', () => {
		const f = baseFixture();
		// Cache-hot revisit: m1 was interpreted as a node surface on a prior
		// visit; root's card surface arrives as usual.
		const tiles = new Map([
			['m1', { title: 'ROCA advisory for the TPM module', typeToken: 'vulnerability', metaType: 'advisory', label: 'ROCA advisory' }],
			['root', { title: 'SHADOW TITLE — must never win the card surface', typeToken: 'generic' }]
		]);
		const view = deriveSubjectGraph([f.root, f.m1, f.b1], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: [cardFor(f.root)],
			tiles
		});
		// Record: tile paints sans with the token — never the rule-5 mono id.
		expect(view.nodes.find((n) => n.id === 'm1')).toMatchObject({
			title: 'ROCA advisory for the TPM module',
			interpreted: true,
			typeToken: 'vulnerability',
			snippet: undefined
		});
		// Product: the card surface outranks the node tile even on a hit.
		expect(view.nodes.find((n) => n.id === 'root')).toMatchObject({
			title: 'AI title',
			interpreted: true,
			typeToken: 'generic'
		});
		// Fallback stays pure without a tile — interpreted marks the voice.
		const noTiles = deriveSubjectGraph([f.root, f.m1, f.b1], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		expect(noTiles.nodes.find((n) => n.id === 'm1')).toMatchObject({ interpreted: false, typeToken: undefined });
	});

	it('subject counts scan the admitted store, not the placed subset', () => {
		const f = baseFixture();
		// m2 never placed (p2 unexpanded) — but it IS an admitted binding of p2.
		const view = deriveSubjectGraph([f.root, f.m1, f.m3, f.p2, f.m2, f.b1, f.b3, f.b2, f.b4], 'root', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		expect(view.nodes.find((n) => n.id === 'root')).toMatchObject({ boundMetadata: 2, files: 1 });
		// p2 binds m1 (URL-bearing) and m2: dossier-parity files count is 1.
		expect(view.nodes.find((n) => n.id === 'p2')).toMatchObject({ boundMetadata: 2, files: 1 });
	});

	it('a metadata subject counts its bound PRODUCTS (dossier Files parity)', () => {
		const f = baseFixture();
		// m1 as the subject: counterparties are root and p2 — both counted,
		// no metadata-kind self-filter (a metadata subject's dossier Files
		// shows exactly these rows).
		const view = deriveSubjectGraph([f.root, f.m1, f.p2, f.b1, f.b2], 'm1', {
			showDeleted: false,
			expanded: NO_EXPAND,
			cards: []
		});
		const subject = view.nodes.find((n) => n.id === 'm1');
		expect(subject).toMatchObject({ boundMetadata: 2, kind: 'metadata', role: 'subject' });
	});
});
