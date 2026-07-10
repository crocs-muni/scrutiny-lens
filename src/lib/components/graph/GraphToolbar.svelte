<script lang="ts">
	import { Minus, Plus, Maximize, RefreshCw, Trash2 } from '@lucide/svelte';

	interface Props {
		zoom?: number;
		nodeCount?: number;
		edgeCount?: number;
		showDeleted?: boolean;
		onZoomIn?: () => void;
		onZoomOut?: () => void;
		onFit?: () => void;
		onLayout?: () => void;
		onToggleDeleted?: () => void;
	}

	let {
		zoom = 1,
		nodeCount = 0,
		edgeCount = 0,
		showDeleted = false,
		onZoomIn,
		onZoomOut,
		onFit,
		onLayout,
		onToggleDeleted
	}: Props = $props();
</script>

<div class="flex h-11 items-center justify-between border-b border-border bg-card px-3">
	<div class="flex items-center gap-1">
		<div class="flex items-center rounded-md border border-border bg-surface p-0.5">
			<button onclick={onZoomOut} class="p-1.5 text-muted-foreground hover:text-foreground"><Minus class="h-4 w-4" /></button>
			<span class="min-w-[3rem] px-2 text-center text-xs font-mono tabular-nums">{Math.round(zoom * 100)}%</span>
			<button onclick={onZoomIn} class="p-1.5 text-muted-foreground hover:text-foreground"><Plus class="h-4 w-4" /></button>
		</div>
		<button onclick={onFit} class="ml-1 flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
			<Maximize class="h-3.5 w-3.5" /> Fit
		</button>
		<button onclick={onLayout} class="ml-1 flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-secondary">
			<RefreshCw class="h-3.5 w-3.5" /> Re-layout
		</button>
	</div>

	<div class="flex items-center gap-3">
		<button
			onclick={onToggleDeleted}
			class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition {showDeleted ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-secondary'}"
		>
			<Trash2 class="h-3.5 w-3.5" /> Show deleted
		</button>
		<span class="text-xs text-muted-foreground">{nodeCount} nodes · {edgeCount} edges</span>
	</div>
</div>
