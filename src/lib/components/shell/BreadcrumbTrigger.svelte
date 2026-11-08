<script lang="ts">
	/* One breadcrumb label. The popup is a supplement for a clipped label and
	 * it is DISABLED — never unmounted — while the full text fits: swapping
	 * the trigger out on the measurement re-parented the label inside the
	 * list item and made the clip state oscillate, freezing the page (caught
	 * in the browser, issue #142 follow-up). One element identity, one
	 * measurement, one tooltip gate. */
	import KeyHint from './KeyHint.svelte';
	import { truncation } from '$lib/truncation';
	import type { NavCrumb } from '$lib/nav';

	interface Props {
		crumb: NavCrumb;
		class: string;
		onActivate?: () => void;
	}

	let { crumb, class: className, onActivate }: Props = $props();

	let clipped = $state(false);
</script>

{#if crumb.action !== null}
	<KeyHint label={crumb.label} nameless silent tooltipDisabled={!clipped} side="bottom">
		{#snippet trigger({ props })}
			<button
				{...props}
				use:truncation={(next) => (clipped = next)}
				type="button"
				class="min-w-[6ch] max-w-full truncate py-3 text-left leading-none {className}"
				onclick={() => onActivate?.()}
			>
				{crumb.label}
			</button>
		{/snippet}
	</KeyHint>
{:else}
	<KeyHint label={crumb.label} nameless silent hoverOnly tooltipDisabled={!clipped} side="bottom">
		{#snippet trigger({ props })}
			<!-- tabindex=-1: not a tab stop, still a focus target for
				focusAfterAscend() after an ascend. -->
			<span
				{...props}
				use:truncation={(next) => (clipped = next)}
				tabindex="-1"
				aria-current={crumb.current ? 'page' : undefined}
				class="min-w-[8ch] max-w-full truncate leading-none {className}"
			>
				{crumb.label}
			</span>
		{/snippet}
	</KeyHint>
{/if}
