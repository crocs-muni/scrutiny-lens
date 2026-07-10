<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';
	import { onMount } from 'svelte';
	import GraphToolbar from './GraphToolbar.svelte';

	interface Props {
		zoom?: number;
		nodeCount?: number;
		edgeCount?: number;
		showDeleted?: boolean;
		onLayout?: () => void;
		onToggleDeleted?: () => void;
		onReady?: (api: ReturnType<typeof useSvelteFlow>) => void;
	}

	let { zoom = 1, nodeCount = 0, edgeCount = 0, showDeleted = false, onLayout, onToggleDeleted, onReady }: Props = $props();
	const flow = useSvelteFlow();

	onMount(() => {
		onReady?.(flow);
	});
</script>

<GraphToolbar
	{zoom}
	{nodeCount}
	{edgeCount}
	{showDeleted}
	onZoomIn={() => flow.zoomIn()}
	onZoomOut={() => flow.zoomOut()}
	onFit={() => flow.fitView({ padding: 0.2 })}
	onLayout={onLayout}
	onToggleDeleted={onToggleDeleted}
/>
