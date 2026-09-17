<script lang="ts">
	/* Settled chat answer renderer (issue #30, ruling 3): layoutAnswer owns
	 * the run/pill split and claim-span marks; ChatRichText is the single
	 * renderer shared with the live stream (chat-output rework T2 — one
	 * pipeline, so live=settled can never drift). This file no longer owns
	 * any markdown or claim CSS. */

	import { layoutAnswer } from '$lib/chat/answer';
	import ChatRichText, { type RichPart } from './ChatRichText.svelte';
	import type { PersistedChatCitation } from '$lib/db';

	interface Props {
		content: string;
		citations: PersistedChatCitation[];
		onOpenDossier: (eventId: string) => void;
	}

	let { content, citations, onOpenDossier }: Props = $props();

	const parts = $derived(layoutAnswer(content, citations) as RichPart[]);
</script>

<ChatRichText {parts} {citations} {onOpenDossier} />
