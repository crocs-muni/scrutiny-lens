<script lang="ts">
	/* PHASE ROW — one of the trace's three capsules (PR #42, spec §2 rule 6).
	 *
	 * VENDORED MUTATION of canon TaskRows' Capsules row
	 * (beautiful-ui-svelte/src/components/TaskRows/TaskRows.svelte): the
	 * badge trio (green check / spinning ring / hollow numbered ring), the
	 * pill pair (Completed / Failed+retry), chevron rotation and the
	 * grid-rows expansion are canon's verbatim. Canon's rows are
	 * demo-scripted; this row derives straight from a PhaseRow in
	 * $lib/trace — deterministic state, never AI, never a timer.
	 *
	 * Row 3 sweep (contract §2): with `progress` (0..1) set, the ring's
	 * arc paints that fraction statically — static leading edge, no spin —
	 * so the sweep reads as a real fill. With `progress` null (the other
	 * running rows) the ring shows canon's plain 28% sweep spinning at
	 * 1.1s. */

	import type { RowStatus, TraceTick as Tick } from '$lib/trace';
	import TraceTick from './TraceTick.svelte';

	interface Props {
		/** 1-based row slot (1..3): ring number + entrance stagger. */
		number: number;
		status: RowStatus;
		label: string;
		/** Right counter; empty while nothing real exists. */
		amount: string;
		ticks: Tick[];
		/** Fill sweep 0..1 while interpreting, else null (plain spin). */
		progress: number | null;
		/** Failed-row retry: re-runs the investigation (spec §1.3). */
		onRetry?: () => void;
	}

	let { number, status, label, amount, ticks, progress, onRetry }: Props = $props();

	const CIRC = 2 * Math.PI * 11;
	const running = $derived(status === 'running');
	const dimmed = $derived(status === 'pending' || status === 'skipped');
	const hasDetail = $derived(ticks.length > 0);

	/* Default-open while the row runs (canon: the literal layer self-opens
	 * live); clicks override, and the override sticks. */
	let manual = $state<boolean | null>(null);
	const open = $derived(manual ?? (running && hasDetail));
	function toggle(): void {
		manual = !open;
	}
</script>

{#snippet ring(active: boolean, sweep: number | null)}
	<!-- canon's ring: track + arc when active, phase number inside -->
	<span class="relative inline-flex shrink-0 items-center justify-center" style:width="24px" style:height="24px">
		<svg
			width="24"
			height="24"
			class="absolute inset-0"
			style:animation={active && sweep === null ? 'spin 1.1s linear infinite' : undefined}
		>
			<circle cx="12" cy="12" r="11" fill="none" stroke="var(--line)" stroke-width="2" />
			{#if active}
				<circle
					cx="12"
					cy="12"
					r="11"
					fill="none"
					stroke="var(--ink-3)"
					stroke-width="2"
					stroke-linecap="round"
					stroke-dasharray={sweep !== null ? `${CIRC * sweep} ${CIRC * (1 - sweep)}` : `${CIRC * 0.28} ${CIRC * 0.72}`}
				/>
			{/if}
		</svg>
		<span class="relative text-[10.5px] font-semibold tabular-nums text-ink">{number}</span>
	</span>
{/snippet}

{#snippet checkIcon()}
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
{/snippet}

{#snippet xIcon()}
	<svg
		width="12"
		height="12"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="3.5"
		stroke-linecap="round"
	>
		<path d="M18 6L6 18M6 6l12 12" />
	</svg>
{/snippet}

{#snippet retryIcon()}
	<svg
		width="12"
		height="12"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="3"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
	</svg>
{/snippet}

{#snippet badge(tone: 'red' | 'green')}
	<span
		class="flex size-5.5 shrink-0 items-center justify-center rounded-full text-white {tone === 'red' ? 'bg-red' : 'bg-green'}"
		style:animation="pop-in 300ms cubic-bezier(0.23,1,0.32,1) both"
	>
		{#if tone === 'green'}
			{@render checkIcon()}
		{:else}
			{@render xIcon()}
		{/if}
	</span>
{/snippet}

{#snippet completedPill()}
	<span
		class="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green"
		style:animation="fade-in 200ms ease-out both"
	>
		Completed
	</span>
{/snippet}

{#snippet failedPill()}
	<span
		class="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red"
		style:animation="fade-in 200ms ease-out both"
	>
		Failed
		{#if onRetry}
			<!-- Retry is a focusable role=button span, not a <button>: the row
				header IS the expand <button> and real buttons don't nest.
				stopPropagation keeps retry from toggling the row's fold. -->
			<span
				role="button"
				tabindex="0"
				aria-label="Retry"
				title="Retry"
				class="flex size-3.5 items-center justify-center rounded-full"
				style:animation="spin 1.2s linear infinite"
				onclick={(e) => {
					e.stopPropagation();
					onRetry();
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						e.stopPropagation();
						onRetry();
					}
				}}
			>
				{@render retryIcon()}
			</span>
		{:else}
			<span style:animation="spin 1.2s linear infinite" class="flex">
				{@render retryIcon()}
			</span>
		{/if}
	</span>
{/snippet}

<div
	class="trace-capsule self-stretch overflow-hidden border-b border-line transition-[background-color] duration-300 last:border-0 hover:bg-inset {dimmed
		? 'opacity-55'
		: ''}"
	style:animation={`fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${(number - 1) * 80}ms both`}
>
	<button
		type="button"
		aria-expanded={hasDetail ? open : undefined}
		onclick={() => hasDetail && toggle()}
		class="flex h-11 w-full items-center gap-2.5 px-2.5 text-left {hasDetail ? '' : 'cursor-default'}"
	>
		<span class="flex size-6 shrink-0 items-center justify-center">
			{#if status === 'completed'}
				{@render badge('green')}
			{:else if status === 'failed'}
				{@render badge('red')}
			{:else}
				{@render ring(running, progress)}
			{/if}
		</span>
		<span class="min-w-0 flex-1 truncate text-[13px] text-ink {running ? 'font-semibold' : 'font-medium'}">
			{label}
		</span>
		{#if amount !== ''}
			<span class="text-[12.5px] text-ink-2 tabular-nums">{amount}</span>
		{/if}
		{#if status === 'completed'}
			{@render completedPill()}
		{:else if status === 'failed'}
			{@render failedPill()}
		{/if}
		{#if hasDetail}
			<span aria-hidden="true" class="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3">
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
					style:transform={open ? 'rotate(180deg)' : 'rotate(0)'}
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</span>
		{/if}
	</button>

	{#if hasDetail}
		<!-- canon's grid-rows expansion (no JS height math), 300ms -->
		<div
			class="grid transition-[grid-template-rows,opacity] duration-300"
			style:grid-template-rows={open ? '1fr' : '0fr'}
			style:opacity={open ? 1 : 0}
			style:transition-timing-function="cubic-bezier(0.23, 1, 0.32, 1)"
		>
			<div class="overflow-hidden">
				<div class="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
					<span aria-hidden="true" class="mx-auto h-full w-px bg-line"></span>
					<div class="flex flex-col gap-1.5">
						{#each ticks as tick, j (j)}
							<TraceTick
								{tick}
								style={open
									? `animation: fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both`
									: undefined}
							/>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	/* Reduced-motion guard (spec §2): freeze the ring spin, kill entrance
	 * fades and the fold grid — instant swaps. `!important` beats the
	 * inline `style:animation` / `style:transition` above. */
	@media (prefers-reduced-motion: reduce) {
		:global(.trace-capsule),
		:global(.trace-capsule *) {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
