<script lang="ts">
	import {
		SvelteFlow,
		Background,
		ConnectionMode,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import {
		forceSimulation,
		forceManyBody,
		forceLink,
		forceCenter,
		forceCollide,
		type Simulation,
		type SimulationNodeDatum,
		type SimulationLinkDatum
	} from 'd3-force';
	import type { GraphView, GraphNode } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import { deriveSubtitle } from '$lib/session/nodeDisplay.js';
	import { connectRelay, disconnectRelay, countBindings } from '$lib/search/relay.js';
	import { rarityScore } from './rarity.js';
	import ProductNode from './ProductNode.svelte';
	import MetadataNode from './MetadataNode.svelte';
	import FloatingEdge from './FloatingEdge.svelte';
	import FlowToolbar from './FlowToolbar.svelte';
	import MiniMap from './MiniMap.svelte';
	import Legend from './Legend.svelte';
	import { onDestroy } from 'svelte';

	interface Props {
		graph: GraphView;
		aiNodes?: Map<string, AIGraphNode>;
		selectedId?: string | null;
		showDeleted?: boolean;
		rootId?: string;
		expandedNodeIds?: string[];
		patchCountByNodeId?: Map<string, number>;
		hopDepth?: number;
		hopLoading?: boolean;
		citationRingId?: string | null;
		citationRingN?: number | null;
		focusRequest?: { nodeId: string; token: number } | null;
		onSelect?: (node: GraphNode) => void;
		onToggleDeleted?: () => void;
		onToggleExpand?: (nodeId: string) => void;
		onHopChange?: (depth: number) => void;
	}

	let {
		graph,
		aiNodes = new Map(),
		selectedId = null,
		showDeleted = true,
		rootId = '',
		expandedNodeIds = [],
		patchCountByNodeId = new Map(),
		hopDepth = 1,
		hopLoading = false,
		citationRingId = null,
		citationRingN = null,
		focusRequest = null,
		onSelect,
		onToggleDeleted,
		onToggleExpand,
		onHopChange
	}: Props = $props();

	// Total binding count per node id, fetched lazily via NIP-45 COUNT and
	// cached here so re-renders (selection, layout) don't refetch. Only
	// populated for non-root nodes actually present in the visible graph.
	let hiddenCounts = $state<Map<string, number>>(new Map());

	const nodeTypes = {
		product: ProductNode,
		metadata: MetadataNode
	};

	const edgeTypes = {
		floating: FloatingEdge
	};

	let flowApi: ReturnType<typeof import('@xyflow/svelte').useSvelteFlow> | null = $state(null);

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let zoom = $state(1);

	function buildNodes(view: GraphView): Node[] {
		return view.nodes
			.filter((n) => showDeleted || !n.retracted)
			.map((n) => {
				const ai = aiNodes.get(n.id);
				const typeTags = n.event.tags.filter((t) => t[0] === 't').map((t) => t[1]);
				let metaType: 'report' | 'target' | 'maintenance' = 'report';
				if (typeTags.includes('scrutiny-target')) metaType = 'target';
				else if (typeTags.includes('scrutiny-maintenance')) metaType = 'maintenance';

				return {
					id: n.id,
					type: n.type,
					position: { x: Math.random() * 400 - 200, y: Math.random() * 300 - 150 },
					data: {
						title: ai?.title ?? n.id.slice(0, 20),
						subtitle: deriveSubtitle(n.event),
						badges: ai?.badges ?? [],
						selected: selectedId === n.id,
						metaType,
						retracted: n.retracted
					}
				};
			});
	}

	function buildEdges(view: GraphView): Edge[] {
		const retractedIds = new Set(view.nodes.filter((n) => n.retracted).map((n) => n.id));
		return view.edges
			.filter((e) => showDeleted || (!retractedIds.has(e.source) && !retractedIds.has(e.target)))
			.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				type: 'floating',
				style: 'stroke:#94a3b8;stroke-width:1.5',
				markerEnd: { type: 'arrowclosed' as const, color: '#94a3b8' }
			}));
	}

	// Continuous, Obsidian-style force layout. A single persistent d3 simulation
	// (not the one-shot "300 ticks then freeze" it used to be) keeps running via
	// its own tick callback, relying on d3's natural alpha decay to quiet down
	// once things settle -- see the d3-force docs on simulation.restart /
	// simulation.alphaTarget / simulation.tick fetched from
	// https://d3js.org/d3-force/simulation before writing this.
	//
	// The simulation's own node datums (SimNode) are kept in a persistent
	// id->datum map, separate from the xyflow Node[] objects, because xyflow's
	// Node.position is a *nested* {x,y}, while d3-force reads/writes flat
	// node.x/node.y -- feeding xyflow Node objects straight into forceSimulation
	// (as the previous runLayout did) never actually moved anything, since d3
	// would set new top-level x/y properties nobody read back into `.position`.
	interface SimNode extends SimulationNodeDatum {
		id: string;
	}
	interface SimLink extends SimulationLinkDatum<SimNode> {
		source: string | SimNode;
		target: string | SimNode;
		metadataRarity: number;
	}

	const WIDTH = 800;
	const HEIGHT = 600;
	// Cards are up to 224px wide (Product) / 192px (Metadata); the previous
	// 80px collide radius was smaller than half of either, so cards could
	// visually overlap even while satisfying the simulation's own collision
	// constraint (it only prevented *centers* from getting closer than 160px).
	const BASE_LINK_DISTANCE = 260;
	const COLLIDE_RADIUS = 150;
	const CHARGE_STRENGTH = -700;

	let simNodesById = new Map<string, SimNode>();
	let sim: Simulation<SimNode, SimLink> | null = null;

	// "Global degree not fetched yet" defaults to rarityScore(1) = 1 (fully
	// vivid/rare) rather than something washed-out: most Metadata nodes turn
	// out to be unique per-certificate documents rather than shared boilerplate,
	// so defaulting to vivid means most nodes never visibly flash/change once
	// the real count arrives -- only the (rarer) common/boilerplate ones dim
	// down after their count loads.
	function rarityOf(nodeId: string): number {
		return rarityScore(hiddenCounts.get(nodeId) ?? 1);
	}

	function buildLinkData(es: Edge[]): SimLink[] {
		// Every Binding edge is metadata(source) -> product(target) (see
		// resolver.ts), so the source end is always the Metadata side whose
		// rarity should drive this edge's distance.
		return es.map((e) => ({
			source: e.source,
			target: e.target,
			metadataRarity: rarityOf(e.source)
		}));
	}

	function linkForceOf(s: Simulation<SimNode, SimLink>) {
		return s.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>;
	}

	/** Merges `ns`/`es` into the running simulation, preserving already-settled
	 * positions/velocities for nodes that existed before (new nodes get NaN
	 * x/y, which d3 initializes via its phyllotaxis arrangement -- see docs),
	 * and reheats so neighbors react instead of jumping. */
	function syncSimulation(ns: Node[], es: Edge[]) {
		const currentIds = new Set(ns.map((n) => n.id));
		for (const id of simNodesById.keys()) {
			if (!currentIds.has(id)) simNodesById.delete(id);
		}
		for (const n of ns) {
			if (!simNodesById.has(n.id)) {
				simNodesById.set(n.id, { id: n.id, x: n.position.x, y: n.position.y });
			}
		}

		const simNodesArr = ns.map((n) => simNodesById.get(n.id)!);
		const linkData = buildLinkData(es);

		if (!sim) {
			sim = forceSimulation(simNodesArr)
				.force('charge', forceManyBody().strength(CHARGE_STRENGTH))
				.force(
					'link',
					forceLink<SimNode, SimLink>(linkData)
						.id((d) => d.id)
						// Higher rarity -> shorter distance (pulled closer to its
						// Product); lower rarity/common metadata -> longer distance.
						.distance((l) => BASE_LINK_DISTANCE * (1.6 - 0.6 * l.metadataRarity))
				)
				.force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
				.force('collide', forceCollide().radius(COLLIDE_RADIUS))
				.on('tick', () => {
					nodes = nodes.map((n) => {
						const sd = simNodesById.get(n.id);
						return sd && sd.x !== undefined && sd.y !== undefined
							? { ...n, position: { x: sd.x, y: sd.y } }
							: n;
					});
				});
		} else {
			sim.nodes(simNodesArr);
			linkForceOf(sim).links(linkData);
		}

		sim.alpha(Math.max(sim.alpha(), 0.6)).restart();
	}

	/** Manual "Re-layout" toolbar button: reheats the same running simulation
	 * (rather than recomputing a one-shot static layout) so it re-settles. */
	function runLayout() {
		if (!sim) return;
		sim.alpha(1).restart();
		requestAnimationFrame(() => flowApi?.fitView({ padding: 0.2 }));
	}

	// Node dragging, Obsidian-style: pin the dragged node's simulation datum to
	// the pointer position (fx/fy) and reheat via alphaTarget so neighbors react
	// live; release the pin and let alphaTarget cool back to 0 on drag end. See
	// simulation.restart / simulation.alphaTarget in the d3-force docs, and the
	// onnodedrag*/NodeTargetEventWithPointer signatures (`{ targetNode, nodes,
	// event }`) confirmed from @xyflow/svelte's own events.d.ts (also matches
	// svelteflow.dev's documented onnodedrag/onnodedragstart/onnodedragstop prop
	// names) before wiring these up.
	function pinDragged(targetNode: Node | null) {
		if (!targetNode || !sim) return;
		const sd = simNodesById.get(targetNode.id);
		if (!sd) return;
		sd.fx = targetNode.position.x;
		sd.fy = targetNode.position.y;
	}

	function onNodeDragStart({ targetNode }: { targetNode: Node | null }) {
		if (!sim) return;
		pinDragged(targetNode);
		sim.alphaTarget(0.3).restart();
	}

	function onNodeDrag({ targetNode }: { targetNode: Node | null }) {
		pinDragged(targetNode);
	}

	function onNodeDragStop({ targetNode }: { targetNode: Node | null }) {
		if (!sim) return;
		if (targetNode) {
			const sd = simNodesById.get(targetNode.id);
			if (sd) {
				sd.fx = null;
				sd.fy = null;
			}
		}
		sim.alphaTarget(0);
	}

	onDestroy(() => {
		sim?.stop();
	});

	$effect(() => {
		const ns = buildNodes(graph);
		const es = buildEdges(graph);
		nodes = ns;
		edges = es;
		zoom = 1;
		syncSimulation(ns, es);
	});

	// Rarity data arrives asynchronously (see the hiddenCounts effect below).
	// When it changes, refresh the Metadata<->Product link distances (rarity
	// also drives physics, not just color) without rebuilding nodes/edges --
	// rebuilding would reset every node's position. Reads `edges` (not `nodes`)
	// so this can't cycle with the tick handler's `nodes` writes above.
	$effect(() => {
		void hiddenCounts;
		if (!sim) return;
		linkForceOf(sim).links(buildLinkData(edges));
		sim.alpha(Math.max(sim.alpha(), 0.3)).restart();
	});

	// Fetches the total binding count for any visible non-root node whose
	// count isn't cached yet. Fires whenever the visible node set changes;
	// already-cached ids are skipped, so this doesn't refetch on unrelated
	// re-renders (selection, layout). One fresh relay connection per batch,
	// disconnected when done -- same connect/disconnect pattern used
	// elsewhere (see relay.ts), not a long-lived shared connection.
	$effect(() => {
		const toFetch = graph.nodes
			.map((n) => n.id)
			.filter((id) => id !== rootId && !hiddenCounts.has(id));
		if (toFetch.length === 0) return;

		let cancelled = false;
		(async () => {
			const ndk = await connectRelay();
			if (!ndk) return;
			try {
				const results = await Promise.all(
					toFetch.map(async (id) => [id, await countBindings(ndk, id)] as const)
				);
				if (cancelled) return;
				const next = new Map(hiddenCounts);
				for (const [id, count] of results) next.set(id, count);
				hiddenCounts = next;
			} finally {
				disconnectRelay(ndk);
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	// Derived, not an effect: an effect that both reads and writes `nodes`
	// (as the previous version did) re-triggers itself every time it runs,
	// since reassigning `nodes` is itself a change to one of its own
	// dependencies — Svelte's effect-depth guard eventually throws
	// `effect_update_depth_exceeded`. A derived value recomputes without
	// writing back to `nodes`, breaking the cycle. Expand/collapse chip state
	// (isRoot/expanded/hiddenCount) is computed here too, for the same
	// reason -- it must react to hiddenCounts/expandedNodeIds without
	// re-running buildNodes (which would reset node positions).
	let displayNodes = $derived(
		nodes.map((n) => {
			const isRoot = n.id === rootId;
			const expanded = expandedNodeIds.includes(n.id);
			const degree = graph.edges.filter((e) => e.source === n.id || e.target === n.id).length;
			const total = hiddenCounts.get(n.id);
			const hiddenCount = !isRoot && !expanded && total !== undefined ? Math.max(0, total - degree) : 0;
			const rarity = n.type === 'metadata' ? rarityOf(n.id) : undefined;
			const citationRing = citationRingId === n.id;
			return {
				...n,
				data: {
					...n.data,
					selected: selectedId === n.id,
					isRoot,
					expanded,
					hiddenCount,
					rarity,
					updateCount: patchCountByNodeId.get(n.id) ?? 0,
					citationRing,
					citationBadge: citationRing ? citationRingN : null,
					onToggleExpand: () => onToggleExpand?.(n.id)
				}
			};
		})
	);

	function onNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		const gn = graph.nodes.find((n) => n.id === node.id);
		if (gn && onSelect) onSelect(gn);
	}

	// A chat citation click force-reveals its target node (see the session
	// store's revealNode) and asks the canvas to pan to it; `token` bumps even
	// when the same nodeId is clicked twice in a row, so this effect re-fires
	// and re-pans instead of no-op'ing on an unchanged dependency.
	$effect(() => {
		const req = focusRequest;
		if (!req) return;
		requestAnimationFrame(() => {
			flowApi?.fitView({ nodes: [{ id: req.nodeId }], duration: 500, padding: 0.5, maxZoom: 1.2 });
		});
	});
</script>

<div class="h-full w-full">
	<SvelteFlow
		nodes={displayNodes}
		{edges}
		{nodeTypes}
		{edgeTypes}
		connectionMode={ConnectionMode.Loose}
		fitView
		minZoom={0.2}
		maxZoom={2}
		onnodeclick={onNodeClick}
		onnodedragstart={onNodeDragStart}
		onnodedrag={onNodeDrag}
		onnodedragstop={onNodeDragStop}
		onmoveend={(_e, viewport) => {
			zoom = viewport.zoom;
		}}
		proOptions={{ hideAttribution: true }}
	>
		<Background gap={26} size={1} bgColor="transparent" patternColor="#d3dae4" />
		<div class="absolute top-4 left-4 z-10">
			<FlowToolbar
				{zoom}
				nodeCount={nodes.length}
				edgeCount={edges.length}
				{showDeleted}
				{hopDepth}
				{hopLoading}
				onLayout={runLayout}
				onToggleDeleted={onToggleDeleted}
				onHopChange={onHopChange}
				onReady={(api) => {
					flowApi = api;
				}}
			/>
		</div>
		<MiniMap />
		<Legend />
	</SvelteFlow>
</div>
