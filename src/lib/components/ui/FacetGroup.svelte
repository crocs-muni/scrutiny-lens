<script lang="ts">
	/* FACET GROUP — one collapsible facet (one kind-tag prefix) in the
	 * results filter rail (issue #38, spec §3: OR within a facet, AND
	 * across). Rows are plain toggles — no parent list to mirror. Long
	 * value lists cap at 8 rows with a local "+N more" expand (local
	 * $state, never a prop) so a namespace with hundreds of kinds can't
	 * blow the rail's height. Counts are mono tabular-nums (spec §9 —
	 * machine-made values). */

	import { IconCheck, IconChevronDown } from '@tabler/icons-svelte';
	import type { FacetGroup as Group } from '$lib/pipeline/cards';

	interface Props {
		group: Group;
		selected: ReadonlySet<string>;
		onToggle(value: string): void;
		/** Optional per-group "clear" affordance — FacetRail wires it. */
		onClearGroup?: () => void;
	}

	let { group, selected, onToggle, onClearGroup }: Props = $props();

	// Presentational ceiling only — the facet is still fully OR-searchable,
	// the cap just hides the long tail until the user asks for it (spec §3).
	const ROW_CAP = 8;

	let open = $state(true);
	let showAll = $state(false);

	const total = $derived(group.values.length);
	const hidden = $derived(showAll ? 0 : total - ROW_CAP);
	const visible = $derived(showAll ? group.values : group.values.slice(0, ROW_CAP));
	const hasSelection = $derived(group.values.some((v) => selected.has(v.value)));
</script>

<div class="border-b border-line last:border-0">
	<!-- header: chevron collapse + mono prefix + distinct-value count -->
	<div class="flex items-center gap-0.5 pb-0.5">
		<button
			type="button"
			class="flex flex-1 items-center gap-1.5 rounded-[6px] px-1 py-1 text-left hover:bg-inset"
			onclick={() => (open = !open)}
		>
			<IconChevronDown
				size={12}
				stroke={1.5}
				class="shrink-0 text-ink-3 transition-transform duration-150 {open ? 'rotate-0' : '-rotate-90'}"
			/>
			<span class="font-mono text-[11px] uppercase tracking-wide text-ink">{group.prefix}</span>
			<span class="ml-auto font-mono text-[10.5px] tabular-nums text-ink-3">{total}</span>
		</button>
		{#if hasSelection && onClearGroup}
			<button
				type="button"
				class="shrink-0 rounded-[6px] px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 hover:bg-inset hover:text-accent-ink"
				onclick={() => onClearGroup()}
			>
				Clear
			</button>
		{/if}
	</div>

	{#if open}
		<div class="pb-1">
			{#each visible as v (group.prefix + ':' + v.value)}
				<button
					type="button"
					class="flex w-full items-center gap-2 rounded-[6px] px-1 py-1 text-left {selected.has(v.value)
						? 'bg-accent-tint'
						: 'hover:bg-inset'}"
					onclick={() => onToggle(v.value)}
				>
					<!-- 8px checkbox square: accent fill + check when selected -->
					<span
						class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] {selected.has(v.value)
							? 'bg-accent text-surface'
							: 'border border-line-strong'}"
					>
						{#if selected.has(v.value)}
							<IconCheck size={12} stroke={2.5} />
						{/if}
					</span>
					<span class="truncate font-mono text-[11px] text-ink">{v.value}</span>
					<span class="ml-auto font-mono text-[10.5px] tabular-nums text-ink-3">{v.count}</span>
				</button>
			{/each}
			{#if hidden > 0}
				<button
					type="button"
					class="px-1 py-0.5 font-mono text-[10.5px] text-ink-3 hover:text-accent-ink"
					onclick={() => (showAll = true)}
				>
					+{hidden} more
				</button>
			{/if}
		</div>
	{/if}
</div>
