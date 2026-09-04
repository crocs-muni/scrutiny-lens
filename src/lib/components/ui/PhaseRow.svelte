<script lang="ts">
	/* PHASE ROW — one of the trace's five rows (issue #36, spec §2 rule 6).
	 *
	 * VENDORED MUTATION of canon TaskRows' List row
	 * (beautiful-ui-svelte/src/components/TaskRows/TaskRows.svelte): the
	 * badge trio (green check / spinning ring / hollow numbered ring),
	 * chevron rotation, and the grid-rows expansion trick are kept verbatim
	 * canon's; canon's own rows are demo-scripted, so the row content here
	 * is a derived PhaseRow from $lib/trace (deterministic state, never AI).
	 *
	 * Counters are mono tabular-nums (spec §9 writing rule — machine-made
	 * values). `skipped` is the honesty state: the row exists but reports
	 * it never ran (descriptions before #38) instead of faking green. */

	import type { PhaseRow } from '$lib/trace';
	import TraceTick from './TraceTick.svelte';

	interface Props {
		index: number;
		row: PhaseRow;
		expanded: boolean;
		onToggle: () => void;
	}

	let { index, row, expanded, onToggle }: Props = $props();

	const hasDetail = $derived(row.ticks.length > 0);
	const dimmed = $derived(row.status === 'pending' || row.status === 'skipped');
</script>

{#snippet ring(active: boolean, number: number)}
	<!-- canon's ring: track + quarter arc when active, phase number inside -->
	<span class="relative inline-flex shrink-0 items-center justify-center" style:width="24px" style:height="24px">
		<svg
			width="24"
			height="24"
			class="absolute inset-0"
			style:animation={active ? 'spin 1.1s linear infinite' : undefined}
		>
			<circle cx="12" cy="12" r="11" fill="none" stroke="var(--line-strong)" stroke-width="2" />
			{#if active}
				<circle
					cx="12"
					cy="12"
					r="11"
					fill="none"
					stroke="var(--ink-3)"
					stroke-width="2"
					stroke-linecap="round"
					stroke-dasharray={`${2 * Math.PI * 11 * 0.28} ${2 * Math.PI * 11 * 0.72}`}
				/>
			{/if}
		</svg>
		<span class="relative font-mono text-[10.5px] font-semibold tabular-nums text-ink">{number}</span>
	</span>
{/snippet}

<div
	class="self-stretch overflow-hidden border-b border-line transition-[border-radius,background-color] duration-300 last:border-0 hover:bg-inset {dimmed
		? 'opacity-55'
		: ''}"
>
	<button
		type="button"
		aria-expanded={hasDetail ? expanded : undefined}
		onclick={() => hasDetail && onToggle()}
		class="flex h-11 w-full items-center gap-2.5 px-2.5 text-left {hasDetail
			? ''
			: 'cursor-default'}"
	>
		<span class="flex size-6 shrink-0 items-center justify-center">
			{#if row.status === 'completed'}
				<span
					class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-green text-white"
					style:animation="pop-in 300ms cubic-bezier(0.23,1,0.32,1) both"
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="3.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M20 6L9 17l-5-5" />
					</svg>
				</span>
			{:else}
				{@render ring(row.status === 'running', index + 1)}
			{/if}
		</span>
		<span
			class="min-w-0 flex-1 truncate text-[13px] text-ink {row.status === 'running'
				? 'font-semibold'
				: 'font-medium'}"
		>
			{row.label}
		</span>
		{#if row.counter !== ''}
			<span class="font-mono text-[12.5px] text-ink-2 tabular-nums">{row.counter}</span>
		{/if}
		{#if row.status === 'completed'}
			<span
				class="inline-flex h-5.5 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green"
				style:animation="fade-in 200ms ease-out both"
			>
				Completed
			</span>
		{/if}
		{#if hasDetail}
			<span
				aria-hidden="true"
				class="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3"
			>
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="transition-transform duration-300"
					style:transform={expanded ? 'rotate(180deg)' : 'rotate(0)'}
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</span>
		{/if}
	</button>

	{#if hasDetail}
		<!-- canon's grid-rows expansion (no JS height math) -->
		<div
			class="grid transition-[grid-template-rows,opacity] duration-200"
			style:grid-template-rows={expanded ? '1fr' : '0fr'}
			style:opacity={expanded ? 1 : 0}
			style:transition-timing-function="cubic-bezier(0.23, 1, 0.32, 1)"
		>
			<div class="overflow-hidden">
				<div class="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
					<span aria-hidden="true" class="mx-auto h-full w-px bg-line"></span>
					<div class="flex flex-col gap-1">
						{#each row.ticks as tick, j (tick.text)}
							<TraceTick
								{tick}
								style={expanded
									? `animation: fade-up 200ms cubic-bezier(0.23,1,0.32,1) ${Math.min(80 + j * 40, 300)}ms both`
									: undefined}
							/>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>
