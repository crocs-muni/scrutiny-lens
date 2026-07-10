<script lang="ts">
	const items = [
		{ label: 'Certificate / Product', color: 'bg-primary' },
		{ label: 'CVE hub', color: 'bg-warning' },
		{ label: 'Report / Target', color: 'bg-info' },
		{ label: 'Patch', color: 'bg-warning/70' },
		{ label: 'Retracted', color: 'bg-destructive' },
		{ label: 'Binding edge', color: 'bg-border', shape: 'line' }
	];
</script>

<div class="absolute bottom-4 left-4 z-10 rounded-[9px] border border-border bg-card/90 p-3 shadow-md backdrop-blur">
	<div class="flex flex-col gap-1.5">
		{#each items as item}
			<div class="flex items-center gap-2">
				{#if item.shape === 'line'}
					<div class="h-0.5 w-3 {item.color}"></div>
				{:else}
					<div class="h-2.5 w-2.5 rounded-sm {item.color}"></div>
				{/if}
				<span class="text-[11px] text-muted-foreground">{item.label}</span>
			</div>
		{/each}
	</div>
</div>
