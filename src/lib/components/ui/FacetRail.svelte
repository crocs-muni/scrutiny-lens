<script lang="ts">
	/* FACET RAIL — results filter rail interior (issue #38, spec §3: OR
	 * within a facet, AND across; chips removable). The page's outer rail
	 * strip already supplies the border, so this is content only: a FILTERS
	 * header, the active-selection chips, one FacetGroup per facet, and a
	 * bottom Clear-all. Chips show `prefix:value` (machine-made → mono,
	 * spec §9) and clicking one re-toggles it off. */

	import { IconX } from '@tabler/icons-svelte';
	import FacetGroup from './FacetGroup.svelte';
	import type { FacetGroup as Group } from '$lib/pipeline/cards';

	interface Props {
		groups: Group[];
		selections: Record<string, Set<string>>;
		onToggle(prefix: string, value: string): void;
		onClearGroup(prefix: string): void;
		onClearAll(): void;
	}

	let { groups, selections, onToggle, onClearGroup, onClearAll }: Props = $props();

	const EMPTY: ReadonlySet<string> = new Set();

	// Flatten active (prefix, value) pairs into the removable chip row.
	const active = $derived(
		Object.entries(selections).flatMap(([prefix, set]) => [...set].map((value) => ({ prefix, value })))
	);
	const anyActive = $derived(active.length > 0);

	// Resolve each group's live selection set once per render.
	const rendered = $derived(
		groups.map((group) => ({ group, selected: selections[group.prefix] ?? EMPTY }))
	);
</script>

<div class="flex h-full w-full flex-col gap-3 overflow-hidden px-3 py-4">
	<h2 class="font-mono text-[10px] uppercase tracking-wide text-ink-3">Filters</h2>

	{#if anyActive}
		<!-- removable chips — one per selected value (spec §3) -->
		<div class="flex flex-wrap gap-1">
			{#each active as { prefix, value } (prefix + ':' + value)}
				<button
					type="button"
					class="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink hover:border-line-strong"
					onclick={() => onToggle(prefix, value)}
				>
					{prefix}:{value}
					<IconX size={10} stroke={2} class="text-ink-3" />
				</button>
			{/each}
		</div>
	{/if}

	<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
		{#each rendered as { group, selected } (group.prefix)}
			<FacetGroup
				{group}
				{selected}
				onToggle={(value) => onToggle(group.prefix, value)}
				onClearGroup={() => onClearGroup(group.prefix)}
			/>
		{/each}
	</div>

	{#if anyActive}
		<button
			type="button"
			class="w-fit shrink-0 font-mono text-[11px] text-ink-3 hover:text-accent-ink"
			onclick={onClearAll}
		>
			Clear all
		</button>
	{/if}
</div>
