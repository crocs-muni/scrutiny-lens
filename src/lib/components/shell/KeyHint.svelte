<script lang="ts">
	/* KEY HINT — the app's one tooltip (spec §9 keyboard rule, issue #39):
	 * label + optional keycap, or a rich body for terms and clipped values.
	 * bits-ui Tooltip is the spec'd headless primitive; the single
	 * Tooltip.Provider lives in routes/+layout.svelte (every route needs it).
	 *
	 * Three call shapes, one surface:
	 *   - default: KeyHint renders the <button> (icon controls, toggles);
	 *   - `trigger`: the caller keeps its own element (link, `div role=button`,
	 *     a span inside a button, a popover trigger) and spreads `props` on it,
	 *     so nothing nests a button in a button;
	 *   - `content`: a rich body replaces the label text (full values, terms).
	 *
	 * Naming (a11y): an icon-only trigger takes `label` as its aria-label and
	 * drops aria-describedby so the name is not announced twice. A trigger
	 * with its own visible text sets `nameless`: no aria-label, and the
	 * tooltip stays a description. The keycap is mirrored as
	 * aria-keyshortcuts, never repeated in the name. */
	import { Tooltip } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLButtonAttributes, 'children' | 'content' | 'id'> {
		/** Action name: the tooltip text and, for icon-only triggers, the aria-label. */
		label?: string;
		/** Keycap text, e.g. "Ctrl+.". */
		keys?: string;
		/** Rich tooltip body; replaces the `label` text. */
		content?: Snippet;
		side?: 'top' | 'right' | 'bottom' | 'left';
		/** The trigger has visible text of its own: no aria-label, keep aria-describedby. */
		nameless?: boolean;
		/** The tooltip repeats text the trigger already exposes (CSS-clipped
		 * text is complete in the DOM): drop aria-describedby. Redundant with
		 * `hoverOnly`, which already drops it. */
		silent?: boolean;
		/** Mouse supplement on a child of an interactive parent (card, node):
		 * no tab stop, no aria-describedby. The meaning must also exist as
		 * visible or sr-only text: nothing essential lives only in a tooltip, and
		 * a child of an interactive parent must not add a second tab stop
		 * (spec §9 keyboard rule, #39). */
		hoverOnly?: boolean;
		/** Suppress the popup without disabling or unmounting the trigger
		 * (clipped-label supplements toggle this instead of swapping the
		 * DOM — a swapped trigger changes the measured width and can
		 * oscillate). Distinct from `disabled`, which disables the trigger. */
		tooltipDisabled?: boolean;
		/** Wrap an existing element: spread `props` on it. `type` is removed
		 * (bits adds type="button" even for non-buttons); real buttons set it themselves. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
		children?: Snippet;
	}

	let {
		label,
		keys,
		content,
		side = 'right',
		nameless = false,
		silent = false,
		hoverOnly = false,
		tooltipDisabled = false,
		trigger,
		children,
		...rest
	}: Props = $props();

	// ARIA names the modifier "Control"; the visible keycap stays "Ctrl".
	const shortcut = $derived(keys?.replace(/^Ctrl\+/, 'Control+'));
</script>

<Tooltip.Root disabled={tooltipDisabled || rest.disabled === true}>
	<Tooltip.Trigger
		{...rest}
		aria-label={nameless ? undefined : label}
		aria-keyshortcuts={shortcut}
	>
		{#snippet child({ props })}
			{@const { 'aria-describedby': describedby, type, ...base } = props}
			{@const triggerProps = {
				...base,
				tabindex: hoverOnly ? undefined : (base.tabindex as number | undefined),
				'aria-describedby': (nameless && !silent && !hoverOnly ? describedby : undefined) as string | undefined
			}}
			{#if trigger}
				{@render trigger({ props: triggerProps })}
			{:else}
				<button type={type as HTMLButtonAttributes['type']} {...triggerProps as HTMLButtonAttributes}>
					{@render children?.()}
				</button>
			{/if}
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Portal>
		<!-- One surface (spec §9 writing rule): full values are shown complete and
			wrapped, never clipped, and stay inside the
			viewport. Values go in `content` as mono + break-all. -->
		<Tooltip.Content
			{side}
			sideOffset={6}
			collisionPadding={8}
			role="tooltip"
			class="z-50 max-w-[min(20rem,calc(100vw-1rem))] rounded-control bg-[var(--tooltip-bg)] px-2 py-1 text-[11.5px] break-words whitespace-normal text-[var(--tooltip-fg)] shadow-raised"
		>
			{#if content}{@render content()}{:else}{label}{/if}
			{#if keys}
				<kbd
					class="ml-1.5 rounded-[5px] border border-[var(--tooltip-border)] px-1 font-mono text-[10px] text-[var(--tooltip-fg)]"
				>{keys}</kbd>
			{/if}
		</Tooltip.Content>
	</Tooltip.Portal>
</Tooltip.Root>
