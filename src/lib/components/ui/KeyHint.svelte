<script lang="ts">
	/* KEY HINT — tooltip with a keycap, on every shell toggle (spec §9
	 * keyboard rule). bits-ui Tooltip is the spec'd headless primitive;
	 * one Tooltip.Provider lives at the shell root in +page.svelte. */
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';

	interface $$Props {
		/** Action name shown in the tooltip and used as the trigger's aria-label. */
		label: string;
		/** Keycap text, e.g. "Ctrl+.". */
		keys: string;
		side?: 'top' | 'right' | 'bottom' | 'left';
		class?: string;
		onclick?: () => void;
		children?: Snippet;
	}

	let { label, keys, side = 'right', class: className = '', onclick, children }: $$Props = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger {onclick} aria-label="{label} ({keys})" class={className}>
		{@render children?.()}
	</Tooltip.Trigger>
	<Tooltip.Portal>
		<Tooltip.Content
			{side}
			sideOffset={6}
			class="z-50 flex items-center gap-1.5 rounded-control bg-[var(--tooltip-bg)] px-2 py-1 text-[11.5px] whitespace-nowrap text-[var(--tooltip-fg)] shadow-raised"
		>
			{label}
			<kbd
				class="rounded-[5px] border border-[var(--tooltip-border)] px-1 font-mono text-[10px] text-[var(--tooltip-fg)]"
			>{keys}</kbd>
		</Tooltip.Content>
	</Tooltip.Portal>
</Tooltip.Root>
