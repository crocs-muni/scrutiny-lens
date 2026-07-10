<script lang="ts">
	import type { GraphView, GraphNode } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import FlowInner from './FlowInner.svelte';

	interface Props {
		graph: GraphView;
		aiNodes?: Map<string, AIGraphNode>;
		selectedId?: string | null;
		showDeleted?: boolean;
		onSelect?: (node: GraphNode) => void;
		onToggleDeleted?: () => void;
	}

	let { graph, aiNodes = new Map(), selectedId = null, showDeleted = true, onSelect, onToggleDeleted }: Props = $props();
</script>

<div class="relative flex h-full w-full flex-col">
	<div
		class="relative flex-1 bg-canvas-bg"
		style="background-image: radial-gradient(var(--color-canvas-dot) 1.1px, transparent 1.1px); background-size: 26px 26px;"
	>
		<FlowInner {graph} {aiNodes} {selectedId} {showDeleted} {onSelect} {onToggleDeleted} />
	</div>
</div>
