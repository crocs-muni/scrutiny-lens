// Canvas-sim machine pins (#102-review F6): the new semantics nobody can
// guess from reading — perceptual early-freeze, arrival seeding + whole-map
// reheat, snap redistribute, drag-pin survival. Fake timers install in
// beforeEach: d3-force's internal timer is chosen lazily at the first
// sim.start()/restart(), so a static import is safe.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
vi.useFakeTimers();
import { CanvasSim } from '$lib/graph/canvas-sim';
import type { SubjectGraphEdge, SubjectGraphNode } from '$lib/graph/subject-graph';

function mkNode(id: string, role: SubjectGraphNode['role'], x: number, y: number): SubjectGraphNode {
	return {
		id,
		kind: role === 'record' ? 'metadata' : 'product',
		role,
		event: {} as never,
		retracted: false,
		title: id,
		interpreted: false,
		typeToken: undefined,
		pubkey: 'pk',
		createdAt: 0,
		snippet: undefined,
		boundMetadata: 0,
		files: 0,
		editedN: 0,
		chainWord: null,
		badge: null,
		x,
		y
	};
}
const TABLE = (nodes: SubjectGraphNode[], edges: SubjectGraphEdge[] = []) => ({ nodes, edges });
const tickMs = (ms: number) => vi.advanceTimersByTime(ms);

describe('CanvasSim (#102 arrival & freeze semantics)', () => {
	let sim: CanvasSim;
	beforeEach(() => {
		sim = new CanvasSim();
	});
	afterEach(() => {
		sim.dispose();
	});

	it('arrivals seed at the subject unpinned; the first settle pin proves frozen-truth', () => {
		const subject = mkNode('s', 'subject', 0, 0);
		sim.applyView(TABLE([subject]));
		tickMs(10000); // first episode fully ends (d3 in-Node timer queue)
		// A second batch: the newcomer enters AT the subject, unpinned —
		// the welcome episode is organic, not a scripted place-at-slot.
		sim.applyView(TABLE([subject, mkNode('m1', 'record', 0, -250)]));
		const m1 = sim.get('m1')!;
		expect(m1.fx).toBeNull();
		expect(Math.hypot(m1.x!, m1.y!)).toBeLessThan(20); // seeded at subject (0,0), not slot
	});

	it('early-freeze: a reheat settles well before the 4.2s default alpha tail', () => {
		const subject = mkNode('s', 'subject', 0, 0);
		sim.applyView(TABLE([subject]));
		tickMs(10000);
		expect(sim.settling()).toBe(false);
		sim.applyView(TABLE([subject, mkNode('m1', 'record', 0, -250), mkNode('m2', 'record', 250, 0)]));
		expect(sim.settling()).toBe(true);
		// The old d3 tail ran ≈254 ticks (4.2s); the eye-truth freeze must
		// land meaningfully before that (probe measured ≈1.5–2.0s).
		tickMs(2800);
		expect(sim.settling()).toBe(false);
	});

	it('redistribute snaps every card to the slot grammar, frozen same frame', () => {
		const nodes = [
			mkNode('s', 'subject', 0, 0),
			mkNode('m1', 'record', 0, -250),
			mkNode('m2', 'record', 250, 0)
		];
		sim.applyView(TABLE(nodes));
		tickMs(10000);
		// Scattered intentionally away from the grammar, then snap:
		sim.get('m1')!.x = -999;
		sim.get('m1')!.y = 777;
		sim.redistribute();
		expect(sim.get('m1')!.x).toBe(nodes[1].x);
		expect(sim.get('m1')!.y).toBe(nodes[1].y);
		expect(sim.get('m2')!.x).toBe(nodes[2].x);
		expect(sim.settling()).toBe(false);
	});

	it('drag pins the node, the world ripples; release keeps the frozen position', () => {
		const subject = mkNode('s', 'subject', 0, 0);
		const m1 = mkNode('m1', 'record', 0, -250);
		sim.applyView(TABLE([subject, m1]));
		tickMs(10000);
		expect(sim.dragStart('m1', 0, -250)).toBe(true);
		sim.dragMove('m1', 330, 120);
		tickMs(1500); // some ripple
		sim.dragEnd('m1');
		tickMs(10000); // cool down fully (early freeze bound)
		const end = sim.get('m1')!;
		expect(sim.settling()).toBe(false);
		// Frozen truth: the released position survives — it can't creep back.
		expect(Math.hypot(end.x! - 330, end.y! - 120)).toBeLessThan(40);
	});
});
