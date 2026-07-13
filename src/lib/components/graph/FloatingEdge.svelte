<script lang="ts">
	import { BaseEdge, useInternalNode, getStraightPath, type EdgeProps } from '@xyflow/svelte';
	import { getEdgeParams } from './floatingEdgeUtils.js';

	let { id, source, target, markerEnd, style }: EdgeProps = $props();

	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);

	let path = $derived.by(() => {
		if (!sourceNode.current || !targetNode.current) return '';
		const { sx, sy, tx, ty } = getEdgeParams(sourceNode.current, targetNode.current);
		const [edgePath] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty });
		return edgePath;
	});
</script>

{#if path}
	<BaseEdge {id} {path} {markerEnd} {style} />
{/if}
