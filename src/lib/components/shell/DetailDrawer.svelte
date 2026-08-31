<script lang="ts">
	/* DETAIL DRAWER — bottom drawer below the canvas (spec §9 + issue #10):
	 * sticky counted sections (Summary · Content · History · Files), a
	 * resizable splitter, a 32px collapsed handle. The drawer stays MOUNTED
	 * when collapsed — the section body is clipped, not destroyed — so the
	 * citation ring (spec §9, chat step) persists across open/closed. */

	import { IconChevronDown, IconChevronUp } from '@tabler/icons-svelte';
	import KeyHint from './KeyHint.svelte';
	import { COLLAPSE } from '../ui/motion';

	interface Section {
		key: SectionKey;
		label: string;
	}
	/** The four dossier sections (spec §9) — counts are keyed to exactly these. */
	type SectionKey = 'summary' | 'content' | 'history' | 'files';

	interface Props {
		open: boolean;
		/** Open height in px. */
		height: number;
		/** Drag clamp upper bound, measured by the parent canvas card. */
		maxHeight: number;
		/** Deterministic per-section counts (spec §2 rule 2) — undefined = hidden. */
		counts?: Partial<Record<SectionKey, number>>;
		onToggle: () => void;
		onResize: (next: number) => void;
	}

	let {
		open,
		height,
		maxHeight,
		counts = {},
		onToggle,
		onResize
	}: Props = $props();

	// spec §9: 32px collapsed handle.
	const COLLAPSED = 32;
	const MIN_OPEN = 168;

	const SECTIONS: Section[] = [
		{ key: 'summary', label: 'Summary' },
		{ key: 'content', label: 'Content' },
		{ key: 'history', label: 'History' },
		{ key: 'files', label: 'Files' }
	];

	let active = $state('summary');
	let dragging = $state(false);

	function startDrag(event: PointerEvent) {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = height;
		dragging = true;
		const move = (e: PointerEvent) =>
			onResize(Math.round(Math.min(Math.max(startHeight + (startY - e.clientY), MIN_OPEN), maxHeight)));
		const up = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}
</script>
<section
	aria-label="Detail drawer"
	data-drawer-collapsed={!open}
	class="relative flex shrink-0 flex-col overflow-hidden border-t border-line"
	style:height="{open ? height : COLLAPSED}px"
	style:transition={dragging ? 'none' : `height ${COLLAPSE.duration}ms ${COLLAPSE.easing}`}
>
	{#if open}
		<!-- splitter: drag between canvas and dossier -->
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize detail drawer"
			onpointerdown={startDrag}
			class="group flex h-2.5 w-full shrink-0 cursor-row-resize touch-none items-center justify-center"
		>
			<span
				class="h-1 w-9 rounded-full bg-line transition-colors duration-150 group-hover:bg-line-strong"
			></span>
		</div>
	{/if}

	<!-- counted section bar sticks to the drawer's top (= the 32px collapsed handle) -->
	<div class="flex h-8 shrink-0 items-center gap-0.5 px-2">
		{#each SECTIONS as section (section.key)}
			<button
				type="button"
				aria-pressed={active === section.key}
				onclick={() => (active = section.key)}
				class="flex h-6 items-center gap-1 rounded-chip px-2 text-[12.5px] font-medium transition-colors duration-100 {active ===
				section.key
					? 'bg-accent-tint text-accent-ink'
					: 'text-ink-2 hover:bg-hover'}"
			>
				{section.label}
				{#if counts[section.key] !== undefined}
					<span class="font-mono text-[11px] text-ink-3">· {counts[section.key]}</span>
				{/if}
			</button>
		{/each}
		<span class="min-w-0 flex-1"></span>
		<KeyHint
			label="Detail drawer"
			keys="Ctrl+Shift+I"
			side="top"
			class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
			onclick={onToggle}
		>
			{#if open}
				<IconChevronDown size={16} stroke-width={2} />
			{:else}
				<IconChevronUp size={16} stroke-width={2} />
			{/if}
		</KeyHint>
	</div>

	<!-- Body stays mounted while collapsed (citation-ring persistence, header
	 * comment); the frame clips it and the copy fades ahead of the height. -->
	<div class="drawer-copy min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
		<p class="max-w-md text-[12.5px] leading-relaxed text-ink-3">
			The {SECTIONS.find((s) => s.key === active)?.label} dossier renders here once a graph node is
			selected — the graph canvas arrives with the product-graph step (spec §11 step 3).
		</p>
	</div>
</section>

<style>
	.drawer-copy {
		opacity: 1;
		transition: opacity 180ms ease-out;
	}
	/* Height collapse: copy exits first, frame follows — same harness
	 * choreography as the column collapses (issue #10). */
	[data-drawer-collapsed='true'] .drawer-copy {
		opacity: 0;
	}
</style>
