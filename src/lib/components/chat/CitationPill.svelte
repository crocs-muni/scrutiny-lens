<script lang="ts">
	/* Citation mark (issue #184, superseding the #30 hover-card anatomy).
	 * The floating card is GONE: it closed 180ms after the pointer left the
	 * pill and nothing on the card cancelled that timer, so its two actions
	 * could never be pressed (WCAG 2.2 SC 1.4.13 "hoverable", failure F95).
	 * The verified quote and both actions now live in the always-visible
	 * source register under the answer; the mark only toggles which row is
	 * open (#185), so every affordance is reachable without a hover path.
	 *
	 * Hover still co-lights the claim, the mark and its register row through
	 * the spotlight — that is how a reader sees which source a sentence
	 * rests on without opening anything. */

	import { spotlight } from './spotlight.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		citation: PersistedChatCitation;
		/** The turn owns which citation's register row is open. */
		open: boolean;
		onToggle: (n: number) => void;
		/** Id of the register row this mark expands — aria-expanded alone
		 * leaves a screen-reader user with no idea which region changed. */
		controls?: string;
	}

	let { citation, open, onToggle, controls }: Props = $props();
</script>

<button
	type="button"
	class="cite-mark"
	class:lit={spotlight.lit([citation.n])}
	style="--cite: var(--cite-{citation.colorIndex});"
	aria-expanded={open}
	aria-controls={controls}
	aria-label="Citation {citation.n}: {citation.nodeTitle ?? 'cited event'}"
	onmouseenter={() => spotlight.hover([citation.n])}
	onmouseleave={() => spotlight.hover(null)}
	onclick={() => onToggle(citation.n)}
>
	{citation.n}
</button>

<style>
	/* Global: the class rides a dynamic string through the renderer.
	 * line-height stays 1 so the mark sits tight to the claim, but min-height
	 * keeps the target taller than the 9px glyph — an earlier draft used
	 * line-height:0 and produced a 9x0px unclickable button. */
	:global(.cite-mark) {
		display: inline-block;
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 9px;
		font-weight: 600;
		line-height: 1;
		color: var(--cite);
		background: none;
		border: none;
		min-height: 13px;
		padding: 2px 2px 1px;
		vertical-align: super;
		cursor: pointer;
	}
	:global(.cite-mark:hover),
	:global(.cite-mark.lit) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
