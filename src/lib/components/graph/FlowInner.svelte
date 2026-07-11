<script lang="ts">
	import {
		SvelteFlow,
		Background,
		Controls,
		Panel,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force';
	import type { GraphView, GraphNode } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import ProductNode from './ProductNode.svelte';
	import MetadataNode from './MetadataNode.svelte';
	import FlowToolbar from './FlowToolbar.svelte';
	import MiniMap from './MiniMap.svelte';
	import Legend from './Legend.svelte';

	interface Props {
		graph: GraphView;
		aiNodes?: Map<string, AIGraphNode>;
		selectedId?: string | null;
		showDeleted?: boolean;
		onSelect?: (node: GraphNode) => void;
		onToggleDeleted?: () => void;
	}

	let { graph, aiNodes = new Map(), selectedId = null, showDeleted = true, onSelect, onToggleDeleted }: Props = $props();

	const nodeTypes = {
		product: ProductNode,
		metadata: MetadataNode
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
						subtitle: ai?.subtitle ?? n.event.pubkey.slice(0, 24),
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
				style: 'stroke:#94a3b8;stroke-width:1.5',
				markerEnd: { type: 'arrowclosed' as const, color: '#94a3b8' }
			}));
	}

	function runLayout() {
		if (nodes.length === 0) return;

		const linkData = edges.map((e) => ({ source: e.source, target: e.target }));
		const width = 800;
		const height = 600;

		const sim = forceSimulation(nodes as unknown as import('d3-force').SimulationNodeDatum[])
			.force('charge', forceManyBody().strength(-400))
			.force('link', forceLink(linkData).id((d: unknown) => (d as Node).id).distance(140))
			.force('center', forceCenter(width / 2, height / 2))
			.force('collide', forceCollide().radius(80))
			.stop();

		for (let i = 0; i < 300; i++) sim.tick();

		nodes = [...nodes];
		requestAnimationFrame(() => flowApi?.fitView({ padding: 0.2 }));
	}

	$effect(() => {
		const ns = buildNodes(graph);
		const es = buildEdges(graph);
		nodes = ns;
		edges = es;
		zoom = 1;
		requestAnimationFrame(runLayout);
	});

	// Derived, not an effect: an effect that both reads and writes `nodes`
	// (as the previous version did) re-triggers itself every time it runs,
	// since reassigning `nodes` is itself a change to one of its own
	// dependencies — Svelte's effect-depth guard eventually throws
	// `effect_update_depth_exceeded`. A derived value recomputes without
	// writing back to `nodes`, breaking the cycle.
	let displayNodes = $derived(
		nodes.map((n) => ({ ...n, data: { ...n.data, selected: selectedId === n.id } }))
	);

	function onNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		const gn = graph.nodes.find((n) => n.id === node.id);
		if (gn && onSelect) onSelect(gn);
	}
</script>

<div class="h-full w-full">
	<SvelteFlow
		nodes={displayNodes}
		{edges}
		{nodeTypes}
		fitView
		minZoom={0.2}
		maxZoom={2}
		onnodeclick={onNodeClick}
		onmoveend={(_e, viewport) => {
			zoom = viewport.zoom;
		}}
		proOptions={{ hideAttribution: true }}
	>
		<Background gap={26} size={1} bgColor="transparent" patternColor="#d3dae4" />
		<Controls />
		<Panel position="top-left">
			<FlowToolbar
				{zoom}
				nodeCount={nodes.length}
				edgeCount={edges.length}
				{showDeleted}
				onLayout={runLayout}
				onToggleDeleted={onToggleDeleted}
				onReady={(api) => {
					flowApi = api;
				}}
			/>
		</Panel>
		<MiniMap />
		<Legend />
	</SvelteFlow>
</div>
