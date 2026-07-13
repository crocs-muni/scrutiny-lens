<script lang="ts">
	import { Minus, Plus, Maximize, RefreshCw, Trash2, Loader2 } from '@lucide/svelte';

	interface Props {
		zoom?: number;
		nodeCount?: number;
		edgeCount?: number;
		showDeleted?: boolean;
		hopDepth?: number;
		hopLoading?: boolean;
		onZoomIn?: () => void;
		onZoomOut?: () => void;
		onFit?: () => void;
		onLayout?: () => void;
		onToggleDeleted?: () => void;
		onHopChange?: (depth: number) => void;
	}

	let {
		zoom = 1,
		nodeCount = 0,
		edgeCount = 0,
		showDeleted = false,
		hopDepth = 1,
		hopLoading = false,
		onZoomIn,
		onZoomOut,
		onFit,
		onLayout,
		onToggleDeleted,
		onHopChange
	}: Props = $props();
</script>

<div class="flex items-center gap-1.5 rounded-[9px] border border-border bg-card/90 p-1.5 shadow-md backdrop-blur">
	<div class="flex items-center rounded-md border border-border bg-surface p-0.5">
		<button onclick={onZoomOut} class="p-1.5 text-muted-foreground hover:text-foreground"><Minus class="h-4 w-4" /></button>
		<span class="min-w-[3rem] px-2 text-center text-xs font-mono tabular-nums">{Math.round(zoom * 100)}%</span>
		<button onclick={onZoomIn} class="p-1.5 text-muted-foreground hover:text-foreground"><Plus class="h-4 w-4" /></button>
	</div>
	<button onclick={onFit} class="flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
		<Maximize class="h-3.5 w-3.5" /> Fit
	</button>
	<button onclick={onLayout} class="flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
		<RefreshCw class="h-3.5 w-3.5" /> Re-layout
	</button>
	<div class="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1" title="Expands or collapses every node up to N hops from the root. Nodes opened individually via a node's own + chip are never collapsed by lowering this.">
		<span class="text-xs font-medium text-muted-foreground">Hop</span>
		<button
			onclick={() => onHopChange?.(hopDepth - 1)}
			disabled={hopLoading || hopDepth <= 1}
			class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
			aria-label="Fewer hops"
		>
			<Minus class="h-3.5 w-3.5" />
		</button>
		<span class="min-w-[1.25rem] text-center text-xs font-mono tabular-nums">{hopDepth}</span>
		<button
			onclick={() => onHopChange?.(hopDepth + 1)}
			disabled={hopLoading}
			class="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
			aria-label="More hops"
		>
			{#if hopLoading}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else}
				<Plus class="h-3.5 w-3.5" />
			{/if}
		</button>
	</div>
	<button
		onclick={onToggleDeleted}
		class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition {showDeleted ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-secondary'}"
	>
		<Trash2 class="h-3.5 w-3.5" /> Show deleted
	</button>
	<span class="whitespace-nowrap px-2 text-xs text-muted-foreground">{nodeCount} nodes · {edgeCount} edges</span>
</div>
