<script lang="ts" module>
	/** Viewport actions the d3 canvas registers with this toolbar (same
	 * surface the xyflow FlowActions used to provide: disabled until ready). */
	export interface CanvasViewportActions {
		zoomIn: () => void;
		zoomOut: () => void;
		fit: () => void;
	}
</script>

<script lang="ts">
	/* CANVAS TOOLBAR (#29b → #95): zoom in / out, fit, REDISTRIBUTE (#95's
	 * only whole-map verb — always user-invoked, then the world freezes
	 * again), the settling chip (discloses whenever the map has heat),
	 * undo-expand chip (visible only while the stack is non-empty), and the
	 * Show-deleted switch (N3). Actions arrive via props from the canvas;
	 * null for the first frame. */

	import {
		IconArrowBackUp,
		IconMaximize,
		IconRefresh,
		IconZoomIn,
		IconZoomOut
	} from '@tabler/icons-svelte';
	import { investigation } from '$lib/investigation.svelte';
	import { shell } from '$lib/shell.svelte';

	interface Props {
		actions: CanvasViewportActions | null;
		/** True while physics runs (an episode). The map discloses its own
		 * motion — "frozen on its own" is the rule, never a hidden stop. */
		settling: boolean;
		/** The only whole-map verb (#95): unpins everything, one episode. */
		onRedistribute: () => void;
	}
	let { actions, settling, onRedistribute }: Props = $props();

	const btn =
		'flex h-8 w-8 items-center justify-center rounded-[7px] text-ink-2 transition-colors hover:bg-hover disabled:opacity-40';
</script>

<div
	class="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"
	role="toolbar"
	aria-label="Graph toolbar"
>
	<button class={btn} title="Zoom in" aria-label="Zoom in" disabled={actions === null} onclick={() => actions?.zoomIn()}
		><IconZoomIn size={14} /></button
	>
	<button class={btn} title="Zoom out" aria-label="Zoom out" disabled={actions === null} onclick={() => actions?.zoomOut()}
		><IconZoomOut size={14} /></button
	>
	<button
		class={btn}
		title="Fit to view"
		aria-label="Fit to view"
		disabled={actions === null}
		onclick={() => actions?.fit()}><IconMaximize size={14} /></button
	>
	<button
		class={btn}
		title="Redistribute: run one layout episode over the whole map, then it freezes again"
		aria-label="Redistribute all"
		onclick={onRedistribute}><IconRefresh size={14} /></button
	>
	<!-- The map's own honesty about motion (#95): only ever SETTLING while
	 * a gesture's episode lives; FROZEN is the baseline, not a button. -->
	<span
		class="ml-1 font-mono text-[10px] {settling ? 'text-[var(--orange)]' : 'text-ink-3'}"
		title={settling ? 'physics running — it stops by itself' : 'fully frozen — nothing moves at rest'}
		>{settling ? 'settling…' : 'frozen'}</span
	>
	{#if investigation.expandedRelated.length > 0}
		<button
			class="flex h-8 items-center gap-1.5 rounded-[7px] border border-line px-2.5 text-[12px] text-ink-2 transition-colors hover:bg-hover"
			title="Undo last expansion"
			onclick={() => investigation.undoExpandRelated()}
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
