<script lang="ts">
	/* CANVAS TOOLBAR (#29b, G1's strip): zoom in / out, fit, undo-expand
	 * (only while the stack is non-empty — BIBLE's chip), and the
	 * Show-deleted switch (N3: retracted nodes are hidden by default).
	 * Lives above the flow, INSIDE the provider, because useSvelteFlow's
	 * context reads at component init. */

	import { useSvelteFlow } from '@xyflow/svelte';
	import {
		IconArrowBackUp,
		IconMaximize,
		IconZoomIn,
		IconZoomOut
	} from '@tabler/icons-svelte';
	import { investigation } from '$lib/investigation.svelte';
	import { shell } from '$lib/shell.svelte';
	import { FIT_OPTIONS } from '$lib/graph/ego';

	const { zoomIn, zoomOut, fitView } = useSvelteFlow();
	const btn =
		'flex h-8 w-8 items-center justify-center rounded-[7px] text-ink-2 transition-colors hover:bg-hover';
</script>

<div
	class="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"
	role="toolbar"
	aria-label="Graph toolbar"
>
	<!-- bare calls: scaleBy's transition path (options.duration) did nothing
	 *	 in 1.6.5 (browser-verified); the Controls plugin calls these bare too. -->
	<button class={btn} title="Zoom in" aria-label="Zoom in" onclick={() => zoomIn()}
		><IconZoomIn size={14} /></button
	>
	<button class={btn} title="Zoom out" aria-label="Zoom out" onclick={() => zoomOut()}
		><IconZoomOut size={14} /></button
	>
	<button
		class={btn}
		title="Fit to view"
		aria-label="Fit to view"
		onclick={() => fitView(FIT_OPTIONS)}><IconMaximize size={14} /></button
	>
	{#if investigation.expandedHubs.length > 0}
		<button
			class="flex h-8 items-center gap-1.5 rounded-[7px] border border-line px-2.5 text-[12px] text-ink-2 transition-colors hover:bg-hover"
			title="Undo last expansion"
			onclick={() => investigation.undoExpandHub()}
		>
			<IconArrowBackUp size={13} />undo expand
		</button>
	{/if}
	<div class="flex-1"></div>
	<!-- N3: retracted nodes never render unless asked; the dossier is never
	 * gated by this (ruling 10/#29a ruling 3). -->
	<button
		role="switch"
		aria-checked={shell.showDeleted}
		class="flex h-8 items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-ink-2 transition-colors hover:bg-hover"
		onclick={() => (shell.showDeleted = !shell.showDeleted)}
	>
		<span
			class="relative h-[14px] w-[26px] rounded-full transition-colors {shell.showDeleted
				? 'bg-accent'
				: 'bg-hover-2'}"
		>
			<span
				class="absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-all {shell.showDeleted
					? 'left-[14px]'
					: 'left-[2px]'}"
			></span>
		</span>
		show deleted
	</button>
</div>
