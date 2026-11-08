<script lang="ts">
	/* ONE settled chat turn (issues #184/#185).
	 *
	 * The turn owns the interaction state the whole surface shares: which
	 * citation's register row is open. The mark and the register row are two
	 * views of that one number, which is why there is no floating card left
	 * to chase — the evidence is already on screen, and a click only says
	 * "show me this one's quote".
	 *
	 * The meta line is computed (spec §2 rule 5). It deliberately does not
	 * say "N verified": scrubAnswer deletes every unverified marker before
	 * the answer renders, so that count can only ever be true. What it says
	 * instead is the record partition and, when the checker threw a claim
	 * away, how many. */

	import AnswerText from './AnswerText.svelte';
	import ChatMessageFooter from './ChatMessageFooter.svelte';
	import { buildTurnMeta, countsLine } from '$lib/chat/turnMeta';
	import type { ChatMessage } from '$lib/chat.svelte';
	import type { NostrEvent } from '$lib/fabric';

	interface Props {
		message: ChatMessage;
		/** The session's admitted set — the only source for a record's
		 * protocol status. Empty after a reload, which is why the register
		 * degrades to a count instead of guessing (§2). */
		grounding: readonly NostrEvent[];
		onOpenDossier: (eventId: string) => void;
	}

	let { message, grounding, onOpenDossier }: Props = $props();

	const meta = $derived(buildTurnMeta(message, grounding));
	const counts = $derived(countsLine(meta));

	/** Open register row; one at a time per turn. */
	let openN = $state<number | null>(null);
	function toggle(n: number): void {
		openN = openN === n ? null : n;
	}

	// A citation that is no longer in this turn's set (session switch mid
	// render) must not leave a stale row open pointing at nothing.
	$effect(() => {
		if (openN !== null && !meta.sources.some((s) => s.n === openN)) openN = null;
	});
</script>

<div class="turn">
	<div class="turn-meta">
		<span class="kick">Answer</span>
		<span class="counts">{counts}</span>
	</div>
	{#if meta.dropped > 0}
		<!-- The only incompleteness this surface can prove: the checker could
		 * not find the quoted text, so the claim was removed before render
		 * (ADR 0003). Stating the number is honest; a model-written caveat
		 * would not be (§2 rule 5). -->
		<p class="trace">
			{meta.dropped} claim{meta.dropped === 1 ? '' : 's'} dropped — the quote was not found in the
			cited record
		</p>
	{/if}
	<AnswerText
		content={message.content}
		citations={message.citations ?? []}
		{openN}
		onToggle={toggle}
	/>
	<ChatMessageFooter
		content={message.content}
		sources={meta.sources}
		{openN}
		onToggle={toggle}
		{onOpenDossier}
	/>
</div>

<style>
	.turn {
		display: flex;
		flex-direction: column;
		overflow-wrap: anywhere;
	}
	.turn-meta {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 6px;
	}
	.kick {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--ink-3);
		flex: none;
	}
	.counts {
		margin-left: auto;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 9.5px;
		color: var(--ink-3);
		white-space: nowrap;
	}
	.trace {
		margin: 0 0 8px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--ink-3);
	}
</style>
