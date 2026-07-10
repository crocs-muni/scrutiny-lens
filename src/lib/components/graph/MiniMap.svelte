<script lang="ts">
	import { MiniMap } from '@xyflow/svelte';
</script>

<div class="absolute bottom-4 right-4 z-10">
	<MiniMap
		class="rounded-[9px] border border-border bg-card/90 backdrop-blur shadow-md"
		style="width: 150px; height: 104px;"
		nodeStrokeWidth={3}
		nodeColor={(n) => {
			if (n.type === 'product') return '#2563eb';
			if (n.type === 'metadata') return '#0ea5e9';
			if (n.type === 'patch') return '#d97706';
			return '#dc2626';
		}}
		maskColor="rgba(255,255,255,0.4)"
	/>
</div>
