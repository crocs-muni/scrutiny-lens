<script lang="ts">
	/* Settled chat answer renderer (issue #30, ruling 3): layoutAnswer owns
	 * the run/mark split and claim-span marks; ChatRichText is the single
	 * renderer shared with the live stream (chat-output rework T2 — one
	 * pipeline, so live=settled can never drift). This file no longer owns
	 * any markdown or claim CSS.
	 *
	 * #185: the citation mark no longer opens a card. The turn owns which
	 * register row is open (`openN`), so this component only forwards it. */

	import { layoutAnswer } from '$lib/chat/answer';
	import ChatRichText, { type RichPart } from './ChatRichText.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		content: string;
		citations: PersistedChatCitation[];
		openN: number | null;
		onToggle: (n: number) => void;
		/** Turn id: prefixes the register row ids the marks point at. */
		idPrefix: string;
	}

	let { content, citations, openN, onToggle, idPrefix }: Props = $props();

	const parts = $derived(layoutAnswer(content, citations) as RichPart[]);
</script>

<ChatRichText {parts} {citations} {openN} {onToggle} {idPrefix} />
