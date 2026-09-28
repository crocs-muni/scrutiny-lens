<script lang="ts">
	/* GRAPH CANVAS (#29b → #95 engine swap) — the subject graph over the
	 * session's admitted store, on d3-force under a derived camera (rulings
	 * 2026-09-27 #95 / 2026-09-28 #103). All prior rulings land unchanged —
	 * the engine, not the grammar, was swapped (@xyflow/svelte is gone):
	 *
	 *  - Subject scope (2): fixed subject + its records + related-product
	 *    multihop ends; deriveSubjectGraph owns topology, canvas-sim owns
	 *    motion, this file owns paint. Slots seed the world; live nodes keep
	 *    their frozen positions across re-derives.
	 *  - Fixed root, free selection (4): selection never moves the layout;
	 *    the {#key} on the root (in +page) remounts the canvas when a NEW
	 *    root anchors, so fit frames one fresh map per anchor.
	 *  - Drawer-only click (6) / empty-pane deselect (7): node click →
	 *    onSelect (the same path the results cards take), empty-canvas
	 *    click → onDeselect; Esc is the page's. The accent ring is
	 *    data-driven (ruling 2/#29a), never canvas-local truth.
	 *  - Admitted-only expansion (8 → #97): the +N bubble is a single-click,
	 *    discrete hit target — records expand their bridges, relateds expand
	 *    their records; every rendered edge is backed by an admitted event
	 *    by construction. Expansion is a BRANCH-LOCAL reheat: the untouched
	 *    map holds exactly.
	 *  - Frozen baseline (#95): no idle motion ever; physics exists only
	 *    inside gestures (drag — every node movable, nothing sacred;
	 *    expansion; the explicit Redistribute), and every episode cools to
	 *    a hard stop by itself, then re-pins. The settling chip in the
	 *    toolbar discloses whenever the map has heat.
	 *  - Chain word (9) on the node; retraction and Show-deleted (10)
	 *    filter in deriveSubjectGraph, the switch lives in the toolbar.
	 *  - Citation ring: the chat's registry pins map to palette slots;
	 *    spotlight hover lights the matching node and forces full detail.
	 *    The registry is non-reactive internally, so the rebuild ticks
	 *    off chat.messages — pins only change with a turn. */

	import '../chat/citations.css';
	import { untrack } from 'svelte';
	// NO d3-zoom here, by ruling (#103 camera grammar): the camera is a pure
	// function of stage size, live bounds center, stored zoom k and a stored
	// pan offset — nothing else can be the truth, so nothing can go stale.
	import GraphNode, { DENSE_NODE_GATE, TIER_HALF, tierOf, type GraphNodeData } from './GraphNode.svelte';
	import CanvasToolbar, { type CanvasViewportActions } from './CanvasToolbar.svelte';
	import { CanvasSim, clipToBorder, type SimNode } from '$lib/graph/canvas-sim';
	import { deriveSubjectGraph, FIT_OPTIONS } from '$lib/graph/subject-graph';
	import { investigation } from '$lib/investigation.svelte';
	import { shell } from '$lib/shell.svelte';
	import { chat } from '$lib/chat.svelte';
	import { CITATION_SLOTS } from '$lib/ai/citationRegistry';
	import { spotlight } from '../chat/spotlight.svelte';
	import type { NostrEvent } from '$lib/fabric';
	import type { ProductCard } from '$lib/pipeline/cards';

	interface Props {
		/** The session's admitted set (ADR 0001 — never the facet-filtered view). */
		events: NostrEvent[];
		cards: ProductCard[];
		/** The graph subject (investigation.graphSubjectId); null → honest empty. */
		root: string | null;
		selectedEventId: string | null;
		onSelect: (id: string) => void;
		onDeselect: () => void;
	}
	let { events, cards, root, selectedEventId, onSelect, onDeselect }: Props = $props();

	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 1.6;
	const FIT_FLOOR = 0.15;

	// --- engine --------------------------------------------------------------
	// Held OUT of the reactive graph: the sim mutates per animation frame;
	// Svelte owns arrays, the sim owns positions. One sim per component
	// instance — the {#key} in +page remounts us per root anchor.
	const sim = new CanvasSim();
	sim.setTick(flushFrame);

	let stage = $state<HTMLDivElement | null>(null);
	let stageW = $state(0);
	let stageH = $state(0);
	// Derived camera (#103): translation is COMPUTED, never stored —
	//   cam = stageCenter − k·boundsCenter + panOffset
	// Stored state is exactly three numbers: zoom level and the user's pan
	// offset. Bounds center is re-measured every flush (cheap, it rides the
	// existing per-frame node sweep), so a stage resize, a settle, or a
	// dragged card re-centers the frame with no special-case refit calls.
	let cameraK = $state(1);
	let panOX = $state(0);
	let panOY = $state(0);
	// FIT GLIDE (machine for the Commands): easing lives ONLY here — damped
	// targets written by fit()/settle-correction, converged by a small rAF
	// loop with exponential smoothing (log-space for k; multiplicative value,
	// equal-ratio glide). Gestures (zoomAt/pan) write the live values and
	// NULL the targets in the same line: the wheel always wins instantly,
	// never a rubber band (scout-verified convention).
	let kTarget: number | null = null;
	let panTarget: [number, number] | null = null;
	let camClaimed = false; // set by any wheel/pan gesture until the next fit
	let boundsVersion = $state(0); // bumped by flushFrame when the center moved
	const boundsC = $derived.by(() => {
		void boundsVersion; // positions live outside the reactive graph — this is the pulse
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const n of sim.nodes) {
			x0 = Math.min(x0, n.x!);
			y0 = Math.min(y0, n.y!);
			x1 = Math.max(x1, n.x!);
			y1 = Math.max(y1, n.y!);
		}
		return x1 === -Infinity ? { x: 0, y: 0 } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
	});
	const cam = $derived({
		k: cameraK,
		x: stageW / 2 - cameraK * boundsC.x + panOX,
		y: stageH / 2 - cameraK * boundsC.y + panOY
	});
	let settling = $state(false);
	let toolbarActions = $state<CanvasViewportActions | null>(null);

	const wrapperRefs = new Map<string, HTMLElement>();
	const lineRefs = new Map<string, SVGLineElement>();

	let draggingId: string | null = null;
	/** Expansion gesture → the branch reheat fires on the corresponding
	 * derived-view apply (the bubble click precedes the store write by design). */
	let pendingExpand: string | null = null;

	const graph = $derived.by(() => {
		if (root === null) return { nodes: [], edges: [] };
		return deriveSubjectGraph(events, root, {
			showDeleted: shell.showDeleted,
			expanded: new Set(investigation.expandedRelated),
			expandedBridges: new Set(investigation.expandedBridges),
			cards,

			// Node-surface interpretations (bySurface.node): the trickle
			// re-renders nodes in place as tiles land (owner ruling C).
			tiles: investigation.nodeTiles
		});
	});

	// #99: the tier ladder is the density safety valve, not the daily tool —
	// full anatomy everywhere until the current view passes the gate, then
	// floors engage for that view (recomputed on re-derive, not per frame).
	const dense = $derived(graph.nodes.length > DENSE_NODE_GATE);

	// The interpretation trickle: report placed ids, in priority order
	// (subject → its records → related products → their records). Cache-first;
	// the lane pays the LLM only for what the card fill never touched.
	$effect(() => {
		if (graph.nodes.length > 0) investigation.nodeFillFor(graph.nodes.map((n) => n.id));
	});

	// Render data is a PURE derived (rung 1 of the effect ladder): merge the
	// derivation with selection/citation/spotlight state. The registry read is
	// untracked (its maps are non-reactive; pins land with a settled turn).
	const nodeData = $derived.by(() => {
		if (root === null) return [] as GraphNodeData[];
		// Citation pins land on a settled chat turn and the registry is
		// non-reactive inside — touching this makes the turn the re-derive
		// trigger (seam: pins rebuild per turn). Untracked reads stay below.
		void chat.messages.length;
		const lit = new Set(spotlight.active);
		return graph.nodes.map((n) => {
			const citeN = untrack(() => chat.registry.numberFor(n.id) ?? null);
			const citationIndex = citeN === null ? null : (citeN - 1) % CITATION_SLOTS;
			return {
				...n,
				selected: n.id === selectedEventId,
				citationIndex,
				citationLit: citeN !== null && lit.has(citeN),
				onSelect,
				onExpand: (target: string) => {
					pendingExpand = target;
					camClaimed = true; // deliberate input — the settle correction stays off
					// The bubble's meaning is role-bound (#97): a record's bubble
					// reveals its related products; a related's reveals its records.
					if (n.role === 'related') investigation.expandRelated(target);
					else investigation.expandBridge(target);
				},
				onHoverChange: (id, hovered) => {
					hoveredId = hovered ? id : hoveredId === id ? null : hoveredId;
				}
			} satisfies GraphNodeData;
		});
	});
	// forced-full flags derive from the SAME merged data the cards see —
	// one citation lookup per node, one truth for tier + edge clipping.
	// Hover bubbles up from GraphNode (user gesture, not a dep of nodeData) so
	// dense-mode edge clipping follows the escalated card size exactly.
	let hoveredId = $state<string | null>(null);
	const forcedFullMap = $derived(
		new Map(nodeData.map((m) => [m.id, m.selected || m.citationLit || m.id === hoveredId]))
	);
	const edgeList = $derived(graph.edges.map((e) => ({ id: e.id, related: e.related })));

	// Sync channel: the derivation is the ONLY trigger; the engine sync is the
	// ONLY side effect. Writes NOTHING to Svelte state (no reads to re-enter,
	// no writes to re-trigger): the 2026-09-27 mount-loop bug class dies here.
	$effect(() => {
		const view = graph; // the single tracked dep
		const added = sim.applyView(view);
		// Analytic pre-fit (#102 ruling, scout-verified Figma/Excalidraw
		// convention): the final frame is a property of the DERIVED slot
		// grammar — computable before the first physics tick. Set it at t=0,
		// instantly (no glide at open), and the welcome plays out INSIDE its
		// already-correct frame.
		if (added.length > 0 && !firstApplyDone) {
			firstApplyDone = true;
			if (stageW > 0) {
				const b = boundsOf(view.nodes as { x: number; y: number }[]);
				if (b) cameraK = fitK(b);
				preFitted = true;
			}
		}
		// Mid-drag removal (live retraction, undo-expand): the card is gone, so
		// its pointerup never lands — cool the episode down at the sync point.
		if (draggingId && !sim.get(draggingId)) {
			sim.dragEnd(draggingId);
			draggingId = null;
			dragCandidate = null;
		}
		// The expansion episode: the bubble click set pendingExpand before the
		// store write; the synchronous re-derive lands here in the same flush.
		if (pendingExpand && sim.get(pendingExpand)) {
			sim.reheat(pendingExpand, added);
			pendingExpand = null;
		}
		// Untracked sweep: flushFrame reads cam/forcedFull, writes settling.
		untrack(flushFrame);
	});

	let lastCX: number | null = null;
	let lastCY: number | null = null;
	function flushFrame() {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const n of sim.nodes) {
			x0 = Math.min(x0, n.x!);
			y0 = Math.min(y0, n.y!);
			x1 = Math.max(x1, n.x!);
			y1 = Math.max(y1, n.y!);
			const el = wrapperRefs.get(n.id);
			if (el) el.style.transform = `translate(${n.x}px, ${n.y}px) translate(-50%, -50%)`;
		}
		if (x1 !== -Infinity) {
			const cx = (x0 + x1) / 2;
			const cy = (y0 + y1) / 2;
			// The camera derives from this center — pulse the reactive world
			// only when it actually moved (frozen map ⇒ no churn).
			if (lastCX === null || lastCY === null || Math.abs(cx - lastCX) > 0.5 || Math.abs(cy - lastCY) > 0.5) {
				lastCX = cx;
				lastCY = cy;
				boundsVersion++;
			}
		}
		for (const e of sim.edges) {
			const ln = lineRefs.get(e.id);
			if (!ln) continue;
			const s = e.source as SimNode;
			const t = e.target as SimNode;
			if (typeof s === 'string' || typeof t === 'string') continue;
			// Edges terminate at the card BORDER of each end (ruling: never
			// pierce to the center). The footprint follows the current tier.
			const foot = (n: SimNode) => {
				// Below the gate every card is always full — skip the tier
				// query entirely (the common case past #99).
				if (!dense) return TIER_HALF.full[n.n.kind];
				const tier = tierOf(true, cam.k, forcedFullMap.get(n.id) ?? false);
				return tier === 'full' ? TIER_HALF.full[n.n.kind] : TIER_HALF[tier];
			};
			const sh = foot(s);
			const th = foot(t);
			const p1 = clipToBorder(s.x!, s.y!, t.x!, t.y!, sh.hw, sh.hh);
			const p2 = clipToBorder(t.x!, t.y!, s.x!, s.y!, th.hw, th.hh);
			ln.setAttribute('x1', p1.x.toFixed(2));
			ln.setAttribute('y1', p1.y.toFixed(2));
			ln.setAttribute('x2', p2.x.toFixed(2));
			ln.setAttribute('y2', p2.y.toFixed(2));
		}
		// Settle correction: the sim waxes hot per episode, and slot gravity
		// holds equilibrium NEAR the grammar, not exactly on it. At the true
		// freeze moment (settling flips false — the only event we can hear),
		// measure the organized bounds; if the fit drifted >10% in k from
		// what the frame shows, glide quietly to it. Never once the user has
		// touched the camera (camClaimed — Mapbox/Excalidraw: don't yank).
		const wasSettling = settling;
		settling = sim.settling();
		if (wasSettling && !settling && !camClaimed && draggingId === null) {
			const sb = simBounds();
			if (sb) {
				const nowK = fitK(sb);
				if (Math.abs(nowK - cameraK) > 0.1 * nowK) {
					kTarget = nowK;
					panTarget = [0, 0];
					ensureDampLoop();
				}
			}
		}
	}

	// --- camera --------------------------------------------------------------
	/** Analytic fit-k for a node spread (slots at open, physics at settle):
	 * the frame is a property of the grammar, computable before motion. */
	function fitK(bounds: { x0: number; y0: number; x1: number; y1: number }): number {
		const spanW = bounds.x1 - bounds.x0;
		const spanH = bounds.y1 - bounds.y0;
		if (spanW < 1 && spanH < 1) return cameraK; // one card: no pan-out meaning
		// The interaction floor (0.25) applies to GESTURES, not to fit:
		// "everything in view" is the fit's contract — clamping fit AT the
		// gesture floor silently crops big maps on short stages. react-flow
		// makes this same fit-below-minZoom allowance.
		return Math.max(
			FIT_FLOOR,
			Math.min(
				FIT_OPTIONS.maxZoom,
				Math.min((stageW || 1) / spanW, (stageH || 1) / spanH) * (1 - FIT_OPTIONS.padding)
			)
		);
	}
	function boundsOf(points: { x: number; y: number }[], padW = 140, padH = 100) {
		if (points.length === 0) return null;
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const n of points) {
			x0 = Math.min(x0, n.x - padW);
			y0 = Math.min(y0, n.y - padH);
			x1 = Math.max(x1, n.x + padW);
			y1 = Math.max(y1, n.y + padH);
		}
		return { x0, y0, x1, y1 };
	}
	function simBounds() {
		return boundsOf(sim.nodes as { x: number; y: number }[]);
	}
	// fit is a COMMAND, never a mode (#103 ruling): hand the frame a fresh k
	// and clear the pan offset — through the glide (≈300 ms convention), so
	// the welcome landing and the toolbar button feel the same.
	function fit(): void {
		const b = simBounds();
		if (!b) return;
		kTarget = fitK(b);
		panTarget = [0, 0];
		camClaimed = false;
		ensureDampLoop();
	}
	/** Instant fit at open — the Figma/Excalidraw convention (no glide at
	 * t=0, or the map starts life smeared). */
	function fitInstant(): void {
		const b = simBounds();
		if (!b) return;
		cameraK = fitK(b);
		panOX = 0;
		panOY = 0;
		kTarget = null;
		panTarget = null;
	}

	let dampRaf: number | null = null;
	let lastStep = 0;
	function ensureDampLoop(): void {
		if (dampRaf !== null) return;
		lastStep = performance.now();
		dampRaf = requestAnimationFrame(dampStep);
	}
	function dampStep(now: number): void {
		const dt = Math.min(0.1, Math.max(0.001, (now - lastStep) / 1000)); // clamp tab-switch spikes
		lastStep = now;
		const t = 1 - Math.exp(-4 * dt); // rate 4 → lands in ~300 ms
		if (kTarget !== null) {
			// log-space: k is multiplicative ⇒ equal ratio, equal glide speed
			cameraK = Math.exp(Math.log(cameraK) + (Math.log(kTarget) - Math.log(cameraK)) * t);
			if (Math.abs(Math.log(kTarget) - Math.log(cameraK)) < 0.005) {
				cameraK = kTarget;
				kTarget = null;
			}
		}
		if (panTarget !== null) {
			panOX += (panTarget[0] - panOX) * t;
			panOY += (panTarget[1] - panOY) * t;
			if (Math.abs(panTarget[0] - panOX) < 0.5 && Math.abs(panTarget[1] - panOY) < 0.5) {
				panOX = panTarget[0];
				panOY = panTarget[1];
				panTarget = null;
			}
		}
		if (kTarget !== null || panTarget !== null) {
			dampRaf = requestAnimationFrame(dampStep);
		} else {
			dampRaf = null;
		}
	}

	/** Zoom anchored at a stage point (wheel: pointer; buttons: center). Keeps
	 * the world point under the anchor glued there — the pan OFFSET absorbs
	 * the k change. A gesture also CLAIMS the camera and kills any in-flight
	 * glide in the same line (gestures never rubber-band). */
	function zoomAt(px: number, py: number, factor: number): void {
		const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cameraK * factor));
		if (next === cameraK) return;
		const qx = (px - cam.x) / cameraK;
		const qy = (py - cam.y) / cameraK;
		cameraK = next;
		panOX = px - stageW / 2 + next * boundsC.x - next * qx;
		panOY = py - stageH / 2 + next * boundsC.y - next * qy;
		kTarget = null;
		panTarget = null;
		camClaimed = true;
	}

	// Ref actions: keep the imperative render loop's DOM map honest across
	// keyed-each rebuilds and root remounts. (use:, not {@attach} — these are
	// per-node list bindings, the one job actions still fit.)
	function registerWrapper(el: HTMLElement, id: string) {
		// The param IS the keyed-each key — Svelte destroys/recreates on key
		// change, so no update() arm ever fires.
		wrapperRefs.set(id, el);
		return {
			destroy() {
				wrapperRefs.delete(id);
			}
		};
	}
	function registerLine(el: SVGLineElement, id: string) {
		lineRefs.set(id, el);
		return {
			destroy() {
				lineRefs.delete(id);
			}
		};
	}

	// --- pointer drag (every node movable — nothing is sacred) ---------------
	// Window-level listeners + a movement threshold; the card keeps ONLY a
	// pointerdown arm. Two hard rules this buys (adversarial review #95):
	//   - immediate setPointerCapture retargets click/dblclick to the wrapper,
	//     killing select (ruling 6) and expand (ruling 8) for real mice — so
	//     no capture at all, moves/ups are heard on the window;
	//   - starting the episode at pointerdown would make every plain click
	//     unpin the whole map and micro-drift it (selection never moves the
	//     layout, ruling 4) — so the drag starts only past ≈4 screen px.
	let dragCandidate: { id: string; pointerId: number } | null = null;
	let firstApplyDone = false;
	let preFitted = false; // the analytic t0 fit lands exactly once (effect or RO)
	// A drag that RELEASES off its card still fires a click on the nearest
	// common ancestor = the stage. Untreated, paneClick would deselect the
	// very node the drag just selected (review F1, #102) — so the episode
	// marks itself and the pane swallows that one click. Same for pan drag.
	let justDragged = false;
	let justPanned = false;

	function onNodePointerDown(id: string, e: PointerEvent) {
		if (e.button !== 0) return;
		// Press-to-select (Figma/Miro/litegraph convention, #101): the ring +
		// drawer land at pointer-DOWN, so the node is already selected when a
		// drag begins — not after the click completes. Re-affirming an
		// already-selected card is a no-op (ruling 10); toggle-off never
		// existed, deselect lives on empty click/Esc.
		onSelect(id);
		dragCandidate = { id, pointerId: e.pointerId };
	}
	function onWindowPointerMove(e: PointerEvent) {
		if (!stage || !dragCandidate || e.pointerId !== dragCandidate.pointerId) return;
		const rect = stage.getBoundingClientRect();
		const wx = (e.clientX - rect.left - cam.x) / cam.k;
		const wy = (e.clientY - rect.top - cam.y) / cam.k;
		if (draggingId !== null) {
			sim.dragMove(draggingId, wx, wy);
			return;
		}
		const n = sim.get(dragCandidate.id);
		if (!n || Math.hypot(wx - n.x!, wy - n.y!) * cam.k < 4) return;
		const id = dragCandidate.id;
		if (!sim.dragStart(id, wx, wy)) {
			dragCandidate = null;
			return;
		}
		draggingId = id;
		justDragged = true;
		camClaimed = true; // any deliberate input owns the camera from here
		flushFrame(); // light the chip without waiting for the first tick
	}
	function onWindowPointerUp(e: PointerEvent) {
		if (draggingId !== null && e.pointerId === dragCandidate?.pointerId) {
			sim.dragEnd(draggingId);
		}
		draggingId = null;
		dragCandidate = null; // a clean click never dragged → never an episode
	}
	// Session graph region (xyflow carried the same aria-label). The attach is
	// a NAMED function: an inline arrow gets a fresh identity at every parent
	// re-render — stable identity → attach once, live until remount.
	// Pointer layout: nodes drag cards (wrapper handler above); the stage's
	// own empty surface PANS (the derived camera's pan offset), wheel ZOOMS
	// around the pointer.
	function setupStage(el: HTMLDivElement): () => void {
		// Pan: starts past ≈4 px on empty stage (never on a card), moves the
		// pan offset 1:1 with the pointer.
		let panning = false;
		let panStart: [number, number] = [0, 0];
		const panDown = (ev: PointerEvent) => {
			if (ev.button !== 0 || (ev.target as HTMLElement).closest('.scrutiny-node')) return;
			panning = true;
			justPanned = false;
			panStart = [ev.clientX - panOX, ev.clientY - panOY];
		};
		const panMove = (ev: PointerEvent) => {
			if (!panning) return;
			const nx = ev.clientX - panStart[0];
			const ny = ev.clientY - panStart[1];
			if (!justPanned && Math.hypot(nx - panOX, ny - panOY) < 4) return;
			justPanned = true;
			camClaimed = true; // a pan gesture owns the camera too
			panOX = nx;
			panOY = ny;
		};
		const panUp = () => (panning = false);
		el.addEventListener('pointerdown', panDown);
		window.addEventListener('pointermove', panMove);
		window.addEventListener('pointerup', panUp);
		const wheel = (ev: WheelEvent) => {
			ev.preventDefault();
			const rect = el.getBoundingClientRect();
			zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * 0.0015));
		};
		el.addEventListener('wheel', wheel, { passive: false });
		// Empty-pane deselect: ONLY the stage itself counts — edges and
		// arrowheads are click targets too, and xyflow's old Pane rule never
		// let edge clicks deselect (ruling 7).
		const paneClick = (ev: MouseEvent) => {
			if (ev.target === el && !justDragged && !justPanned) onDeselect();
			justDragged = false; // one-shot swallows, drag or not
			justPanned = false;
		};
		el.addEventListener('click', paneClick);
		window.addEventListener('pointermove', onWindowPointerMove);
		window.addEventListener('pointerup', onWindowPointerUp);
		toolbarActions = {
			zoomIn: () => zoomAt(stageW / 2, stageH / 2, 1.3),
			zoomOut: () => zoomAt(stageW / 2, stageH / 2, 1 / 1.3),
			fit
		};
		// The ONLY resize work left: feed the derived camera fresh stage
		// dims. Re-centering is free from here — it is one derived line, not
		// a call chain.
		const resizeObserver = new ResizeObserver((entries) => {
			const r = entries[0].contentRect;
			stageW = r.width;
			stageH = r.height;
			// The first stage-size notification lands AFTER the first apply
			// (attach→measure is async): the t0 pre-fit waits, not dies —
			// still instant, still before the visible frames.
			if (!preFitted && firstApplyDone && !camClaimed) {
				const b = boundsOf(graph.nodes as { x: number; y: number }[]);
				if (b) cameraK = fitK(b);
				preFitted = true;
			}
		});
		resizeObserver.observe(el);
		return () => {
			resizeObserver.disconnect();
			el.removeEventListener('pointerdown', panDown);
			el.removeEventListener('wheel', wheel);
			el.removeEventListener('click', paneClick);
			window.removeEventListener('pointermove', panMove);
			window.removeEventListener('pointerup', panUp);
			window.removeEventListener('pointermove', onWindowPointerMove);
			window.removeEventListener('pointerup', onWindowPointerUp);
			if (dampRaf !== null) cancelAnimationFrame(dampRaf);
			dampRaf = null;
			sim.dispose();
			toolbarActions = null;
		};
	}
</script>

{#if root === null}
	<!-- honest empty (ruling 7 vocabulary): no placeholder graph, ever -->
	<div class="flex min-h-0 w-full flex-1 items-center justify-center">
		<p class="max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
			Open a result to see its graph — the canvas grows from admitted bindings, never from
			guesses.
		</p>
	</div>
{:else}
	<div
		class="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface"
	>
		<CanvasToolbar actions={toolbarActions} settling={settling} onRedistribute={() => sim.redistribute()} />
		<!-- Session graph region (xyflow carried the same aria-label). The click
		 * listener is imperative (attach zone, next to zoom): template-level
		 * clicks on a static div fight the a11y linter for zero gain — Esc
		 * stays the keyboard deselect (page-level), unaffected by the swap. -->
		<div class="stage min-h-0 flex-1" aria-label="Session graph" bind:this={stage} {@attach setupStage}>
			<div class="world" style="transform: translate({cam.x}px, {cam.y}px) scale({cam.k})">
				<svg class="edges" aria-hidden="true">
					<defs>
						<marker
							id="scrutiny-arrow-ink"
							viewBox="0 0 20 20"
							refX="16"
							refY="10"
							markerWidth="13"
							markerHeight="13"
							markerUnits="userSpaceOnUse"
							orient="auto-start-reverse"
						>
							<path d="M 0 1 L 14 10 L 0 19 z" fill="var(--ink-3)" />
						</marker>
						<marker
							id="scrutiny-arrow-related"
							viewBox="0 0 20 20"
							refX="16"
							refY="10"
							markerWidth="13"
							markerHeight="13"
							markerUnits="userSpaceOnUse"
							orient="auto-start-reverse"
						>
							<path d="M 0 1 L 14 10 L 0 19 z" fill="var(--orange)" />
						</marker>
					</defs>
					{#each edgeList as e (e.id)}
						<line use:registerLine={e.id} class:related={e.related} />
					{/each}
				</svg>
				{#each nodeData as n (n.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="scrutiny-node"
						use:registerWrapper={n.id}
						onpointerdown={(e) => onNodePointerDown(n.id, e)}
					>
						<GraphNode data={n} zoom={cam.k} dense={dense} />
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.stage {
		position: relative;
		overflow: hidden;
		cursor: default;
		touch-action: none;
		/* Dots background — parity with the xyflow era (BackgroundVariant.Dots,
		 * gap 22, size 1, --line-strong). */
		background-image: radial-gradient(var(--line-strong) 1px, transparent 1.6px);
		background-size: 22px 22px;
	}
	.world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
	}
	.edges {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
	}
	/* --ink-3, not --line-strong: the hairline tone is white-on-white in
	 * LIGHT mode (owner screenshot, xyflow era). Related = amber dashed
	 * multihop language (G1); arrows at the destination end (N1⑦). */
	.edges line {
		stroke: var(--ink-3);
		stroke-width: 1.8;
		marker-end: url(#scrutiny-arrow-ink);
	}
	.edges line.related {
		stroke: var(--orange);
		stroke-dasharray: 4 5;
		marker-end: url(#scrutiny-arrow-related);
	}
	.scrutiny-node {
		position: absolute;
		left: 0;
		top: 0;
		cursor: grab;
		will-change: transform;
		/* drag = move the card, never select its text (adversarial L6) */
		user-select: none;
		-webkit-user-select: none;
	}
	.scrutiny-node:active {
		cursor: grabbing;
	}
</style>
