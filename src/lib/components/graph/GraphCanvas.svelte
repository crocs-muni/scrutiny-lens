<script lang="ts">
	import type { GraphView, GraphNode } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import FlowInner from './FlowInner.svelte';

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
		/** Node id to ring + badge as a citation source (hover or active-click). */
		citationRingId?: string | null;
		citationRingN?: number | null;
		/** Bumping the token re-triggers a camera pan to nodeId even if it's the same id as before. */
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
</script>

<div class="relative flex h-full w-full flex-col">
	<div
		class="relative flex-1 bg-canvas-bg"
		style="background-image: radial-gradient(var(--color-canvas-dot) 1.1px, transparent 1.1px); background-size: 26px 26px;"
	>
		<FlowInner
			{graph}
			{aiNodes}
			{selectedId}
			{showDeleted}
			{rootId}
			{expandedNodeIds}
			{patchCountByNodeId}
			{hopDepth}
			{hopLoading}
			{citationRingId}
			{citationRingN}
			{focusRequest}
			{onSelect}
			{onToggleDeleted}
			{onToggleExpand}
			{onHopChange}
		/>
	</div>
</div>
