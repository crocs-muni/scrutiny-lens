/**
 * CANVAS-SIM (#95) — the d3-force engine behind the session graph. Pure
 * module: no Svelte, no DOM, no stores; the component owns refs and store
 * reads, this class owns positions and motion. Subject-graph slots remain
 * the geometry of record — physics exists only as a gesture-local episode.
 *
 * Interaction contract (owner ruling 2026-09-27; mechanics are the verbatim
 * d3 idiom from @d3/force-directed-graph-canvas/-tree):
 *
 *  - BASELINE: frozen. Every node is pinned (fx/fy = current coords); the
 *    simulation timer is off. Nothing breathes at rest — positions are
 *    admitted slots (new arrivals) or the last frozen state (live nodes).
 *  - DRAG: EVERY node is grabbable, including the subject — nothing is
 *    sacred. While the pointer holds a node, the whole component breathes
 *    (alphaTarget(0.3).restart() — the notebooks' line) and the grabbed
 *    node follows the pointer exactly (fx/fy). Release → cools to a full
 *    stop by itself (d3's built-in alphaMin halt; nobody writes a stop
 *    button), and every node re-pins where it lies.
 *  - EXPANSION: a branch-local episode — only the expanded node's 2-hop
 *    neighborhood and the freshly admitted leaves move; the rest of the
 *    audited map holds exactly (measured honesty, like the spike's
 *    0.00px guarantee).
 *  - REDISTRIBUTE: the only whole-map verb, always user-invoked. Then the
 *    world finds its shape once and freezes again.
 *
 * Determinism: d3-force ships a fixed-seed LCG and slots seed the world, so
 * the same view + same gesture sequence reproduces the same frozen map.
 * Positions are never persisted anywhere: a remount re-derives slots.
 */

import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type ForceLink,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum
} from 'd3-force';
import type { SubjectGraph, SubjectGraphEdge, SubjectGraphNode } from './subject-graph';

/** A sim node carries the derivation's anatomy as payload (`n`). */
export interface SimNode extends SimulationNodeDatum {
	id: string;
	n: SubjectGraphNode;
}
export interface SimEdge extends SimulationLinkDatum<SimNode> {
	id: string;
	related: boolean;
}

/** Link distance in model px per adjacency kind — echoes the derivation's
 * ring grammar (r1 252/432, +250 per ring) so physics relaxes into the
 * same spacing the slots encode. */
const LINK_DISTANCE = { ring: 300, leaf: 280 } as const;
/** Collide radius ≈ card half-diagonal + gutter, so cards cannot overlap
 * during episodes. Sizing lives next to the anatomy (GraphNode module). */
const COLLIDE_RADIUS: Readonly<Record<SubjectGraphNode['kind'], number>> = {
	product: 150,
	metadata: 140
};

/**
 * 2-hop breath set for a branch-local episode: the center, its direct
 * bridge neighbors, and their neighbors in turn (this is what lets #87
 * stack-mates on a shared bridge un-stack when the stack is touched).
 * The set is local by construction — the rest of the map holds.
 */
function breathSet(centerId: string, adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
	const out = new Set<string>([centerId]);
	for (const a of adjacency.get(centerId) ?? []) {
		out.add(a);
		for (const b of adjacency.get(a) ?? []) out.add(b);
	}
	return out;
}

/**
 * Clip the segment (cx,cy)→(tx,ty) at the border of the rect centered at
 * (cx,cy) with half-extents (hw, hh). Edges terminate at the card's facing
 * border — never pass under the node (owner ruling 2026-09-27). Degenerates
 * to the center when the segment is a point (stacked nodes, #87).
 */
export function clipToBorder(
	cx: number,
	cy: number,
	tx: number,
	ty: number,
	hw: number,
	hh: number
): { x: number; y: number } {
	const dx = tx - cx;
	const dy = ty - cy;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	const txClamp = dx === 0 ? Infinity : hw / Math.abs(dx);
	const tyClamp = dy === 0 ? Infinity : hh / Math.abs(dy);
	const t = Math.min(txClamp, tyClamp);
	return { x: cx + dx * t, y: cy + dy * t };
}

export class CanvasSim {
	/** The expansion dbl-click targets this edge set: adjacency in DERIVATION
	 * terms (every edge counts, both directions), since breath locality is a
	 * topology question. */
	private adjacency = new Map<string, Set<string>>();

	nodes: SimNode[] = [];
	edges: SimEdge[] = [];

	private sim: Simulation<SimNode, SimEdge>;
	private byId = new Map<string, SimNode>();
	private tickCb: (() => void) | null = null;
	private dragging: string | null = null;

	constructor() {
		this.sim = forceSimulation<SimNode, SimEdge>(this.nodes)
			.force('charge', forceManyBody<SimNode>().strength(-120))
			.force('link', forceLink<SimNode, SimEdge>(this.edges).id((n) => n.id))
			.force('collide', forceCollide<SimNode>((n) => COLLIDE_RADIUS[n.n.kind]).iterations(2))
			.force('x', forceX(0).strength(0.03))
			.force('y', forceY(0).strength(0.03))
			.stop();
		this.sim.on('tick', () => this.tickCb?.());
		this.sim.on('end', () => this.freeze());
		// Baseline truth: cooler than the off-switch, not merely stopped —
		// stop() leaves alpha hot (the spike's "stuck settling" bug).
		this.sim.alpha(0);
	}

	setTick(cb: (() => void) | null): void {
		this.tickCb = cb;
	}

	settling(): boolean {
		return this.sim.alpha() > this.sim.alphaMin();
	}
	get(id: string): SimNode | undefined {
		return this.byId.get(id);
	}

	/**
	 * Reconcile the derived view into the live world. Slot geometry is
	 * authoritative ONLY for nodes that don't exist yet — live nodes keep
	 * wherever the user's gestures (or nothing) left them, so re-derives
	 * (tiles, citations, show-deleted) never reset the map.
	 * Returns the ids of nodes added by this view.
	 */
	applyView(view: SubjectGraph): string[] {
		const wanted = new Map(view.nodes.map((n) => [n.id, n]));
		const added: string[] = [];
		for (const n of view.nodes) {
			const cur = this.byId.get(n.id);
			if (cur) {
				cur.n = n; // anatomy/state refreshes in place; position is the map's truth
			} else {
				// New arrivals PIN at their slot: the baseline is frozen by
				// construction, and only a gesture (reheat/drag) releases them.
				const sn: SimNode = { id: n.id, n, x: n.x, y: n.y, vx: 0, vy: 0, fx: n.x, fy: n.y };
				this.byId.set(n.id, sn);
				this.nodes.push(sn);
				added.push(n.id);
			}
		}
		// Removals: undo-expand leaves, show-deleted hides, apply-driven
		// shrinkage. Positions of survivors are untouched — no motion.
		this.nodes = this.nodes.filter((sn) => wanted.has(sn.id));
		for (const id of [...this.byId.keys()]) if (!wanted.has(id)) this.byId.delete(id);

		this.edges = view.edges.map((e: SubjectGraphEdge) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			related: e.related
		}));
		this.adjacency = new Map();
		for (const e of view.edges) {
			let s = this.adjacency.get(e.source);
			if (!s) this.adjacency.set(e.source, (s = new Set()));
			s.add(e.target);
			let t = this.adjacency.get(e.target);
			if (!t) this.adjacency.set(e.target, (t = new Set()));
			t.add(e.source);
		}

		const link = this.sim.force('link') as ForceLink<SimNode, SimEdge>;
		link.links(this.edges).distance((e) => (e.related ? LINK_DISTANCE.leaf : LINK_DISTANCE.ring));
		this.sim.nodes(this.nodes);
		return added;
	}

	private freeze(): void {
		// Episode over (d3's built-in halt): re-pin everything where it lies —
		// the frozen map IS the truth, motion never outlives its gesture.
		for (const n of this.nodes) {
			n.fx = n.x;
			n.fy = n.y;
		}
		this.tickCb?.(); // final flush so the DOM matches the frozen truth
	}

	/** Expansion episode: only the branch organizes (measured 0px elsewhere). */
	reheat(centerId: string, newcomerIds: string[]): void {
		if (this.dragging) return;
		const set = breathSet(centerId, this.adjacency);
		for (const id of newcomerIds) set.add(id);
		for (const n of this.nodes) {
			if (set.has(n.id)) {
				n.fx = null;
				n.fy = null;
			} else {
				n.fx = n.x;
				n.fy = n.y;
			}
		}
		this.sim.alpha(0.35).alphaTarget(0).restart();
	}

	/** The only whole-map episode. Always user-invoked (Redistribute). */
	redistribute(): void {
		if (this.dragging) return;
		for (const n of this.nodes) {
			n.fx = null;
			n.fy = null;
		}
		this.sim.alpha(0.6).alphaTarget(0).restart();
	}

	/** Drag = the notebooks' line, with EVERY node grabbable (nothing sacred).
	 * The whole component breathes while the pointer holds ("the world flows
	 * around whatever the user moves"); release starts the cool-down. */
	dragStart(id: string, wx: number, wy: number): boolean {
		const n = this.byId.get(id);
		if (!n || this.dragging) return false;
		this.dragging = id;
		for (const m of this.nodes) {
			m.fx = null;
			m.fy = null;
		}
		n.fx = wx;
		n.fy = wy;
		this.sim.alphaTarget(0.3).restart();
		return true;
	}
	dragMove(id: string, wx: number, wy: number): void {
		const n = this.byId.get(id);
		if (!n || this.dragging !== id) return;
		n.fx = wx;
		n.fy = wy;
	}
	dragEnd(id: string): void {
		// Robust against mid-drag removal (live retraction, undo-expand): the
		// dragged node may be gone — cool the sim down regardless, else
		// alphaTarget(0.3) holds the map hot forever.
		if (this.dragging !== id) return;
		this.dragging = null;
		this.sim.alphaTarget(0);
		// Gone-dragged never gets a drop-pin; surviving nodes re-pin on halt.
	}

	dispose(): void {
		this.sim.stop();
	}
}
