<script lang="ts">
	/* CHAT COLUMN — resident only while a session is open (spec §9); the
	 * parent unmounts it on the search/results views. Collapsed state is a
	 * 48px card stub carrying ONE element — the chat icon as the toggle,
	 * unread dot on its corner (owner ruling 2026-09-03, "B").
	 *
	 * Content (issue #30): transcript + live stream + composer. The column
	 * reads the chat store directly (TaskTrace/SettingsDialog precedent) and
	 * takes only what the page owns: the grounding flag (does the session's
	 * admitted set live in memory) and the send closure (provider + events
	 * + root summary are page context).
	 *
	 * Degraded states are honest and local (ruling 6): no key → the composer
	 * says why and points at Settings; events not in memory → transcript
	 * stays readable, asking is disabled with the reason. */

	import '../chat/citations.css';
	import { IconArrowBarToRight, IconMessage } from '@tabler/icons-svelte';
	import KeyHint from './KeyHint.svelte';
	import { COLLAPSE } from '../ui/motion';
	import AnswerText from '../chat/AnswerText.svelte';
	import ChatMessageFooter from '../chat/ChatMessageFooter.svelte';
	import LoadingState from '../chat/LoadingState.svelte';
	import ChatComposer from '../chat/ChatComposer.svelte';
	import { chat } from '$lib/chat.svelte';
	import { settings } from '$lib/settings.svelte';
	import { parseChatStream } from '$lib/chat/streamParse';
	import ChatRichText, { type RichPart } from '../chat/ChatRichText.svelte';

	interface Props {
		collapsed: boolean;
		onToggle: () => void;
		unread?: boolean;
		/** The session's admitted set is in memory — asking needs it
		 * (transcript never does). */
		grounded: boolean;
		onSend: (question: string) => void;
		onOpenDossier: (eventId: string) => void;
	}

	let { collapsed, onToggle, unread = false, grounded, onSend, onOpenDossier }: Props = $props();

	// Width-only 280ms; copy fades in 180ms ahead of it (issue #10).
	const MOTION = {
		expandedWidth: 320,
		collapsedWidth: 48,
		...COLLAPSE
	};

	const hasKey = $derived(settings.apiKey !== '');
	const composerNote = $derived.by((): string | null => {
		if (!hasKey)
			return 'Chat needs an AI key — set one in Settings (Ctrl+,). Answers are verified against this session’s events.';
		if (!grounded)
			return 'This session’s events aren’t in memory — the transcript stays readable; asking unlocks when the session’s events are admitted.';
		return null;
	});

	/** Eager number for a pending-shimmer pill: pinned only for events the
	 * grounding set actually holds — a fabricated id must never consume a
	 * number (ruling 4 + the registry's pinning contract). */
	const pinShimmer = (eventId: string): number | null =>
		chat.grounding.some((e) => e.id === eventId) ? chat.registry.next(eventId) : null;

	/* Live parts = the same RichPart vocabulary as the settled path: prose
	 * becomes markdown-able text runs, pending markers become shimmer. */
	const liveParts: RichPart[] = $derived(
		chat.live === null
			? []
			: parseChatStream(chat.live.raw, pinShimmer).map((s): RichPart =>
					s.kind === 'prose' ? { kind: 'text', text: s.text, marks: [] } : { kind: 'pending', n: s.n }
				)
	);

	let scrollEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		// Pin to the newest content: any transcript or stream growth scrolls.
		chat.messages.length;
		chat.live?.raw;
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
	});
</script>

<aside
	data-chat-collapsed={collapsed}
	aria-label="Chat"
	class="relative flex h-full shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card transition-[width]"
	style:width={collapsed ? `${MOTION.collapsedWidth}px` : `${MOTION.expandedWidth}px`}
	style:transition-duration="{MOTION.duration}ms"
	style:transition-timing-function={MOTION.easing}
	style:--chat-copy-duration="{MOTION.copyDuration}ms"
	style:--chat-copy-offset="{MOTION.copyOffset}px"
	style:--chat-easing={MOTION.easing}
>
	<!-- open-width content: fixed 320px, clipped by the frame (no reflow) -->
	<div class="chat-copy flex h-full w-[320px] shrink-0 flex-col" inert={collapsed}>
		<header class="flex h-11 shrink-0 items-center border-b border-line px-3">
			<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">Chat</span>
			<KeyHint
				label="Chat column"
				keys="Ctrl+."
				side="bottom"
				class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
				onclick={onToggle}><IconArrowBarToRight size={18} stroke-width={1.8} /></KeyHint
			>
		</header>

		<div bind:this={scrollEl} class="chat-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
			{#each chat.messages as message (message.id)}
				{#if message.role === 'user'}
					<div class="user-bubble">{message.content}</div>
				{:else if message.kind === 'ungrounded'}
					<div class="ungrounded">
						Can’t answer that from this session — it contains: <span class="ungrounded-ctx"
							>{message.availableContext}</span
						>
					</div>
				{:else}
					<div class="assistant">
						<AnswerText
							content={message.content}
							citations={message.citations ?? []}
							{onOpenDossier}
						/>
						<ChatMessageFooter
							content={message.content}
							citations={message.citations ?? []}
							{onOpenDossier}
						/>
					</div>
				{/if}
			{/each}

			{#if chat.live !== null}
				<div class="user-bubble">{chat.live.question}</div>
				<div class="assistant">
					{#if chat.live.raw === ''}
						<!-- thinking lane: vendored LoadingState (beautiful-ui, MIT)
							— grid loader + shimmer label + elapsed timer; the honest
							>30s degrade (ruling 6) is simply this state lasting. -->
						<LoadingState label="Thinking" />
					{:else}
						<!-- Same renderer as the settled path (chat-output T2): markdown
							from the FIRST delta, pending shimmer for unverified markers. -->
						<ChatRichText parts={liveParts} {onOpenDossier} />
					{/if}
				</div>
			{/if}

			{#if chat.error !== null}
				<!-- ruling 6: the failed turn's question and partial prose stay
					on screen; only the error itself is a bubble. -->
				<div class="user-bubble">{chat.error.question}</div>
				<div class="error-bubble">
					{#if chat.error.partial !== undefined}
						<!-- ruling 6: the stream's partial prose stays on screen —
							plain text with markers suppressed, never styled as trust
							(verification never ran on it). -->
						<p class="error-partial">
							{parseChatStream(chat.error.partial, () => null)
								.filter((s) => s.kind === 'prose')
								.map((s) => s.text)
								.join('')}
						</p>
					{/if}
					<p class="error-line">Answer failed: {chat.error.message}</p>
					<button class="error-retry" onclick={() => onSend(chat.error!.question)}>retry</button>
				</div>
			{/if}

			{#if chat.messages.length === 0 && chat.live === null && chat.error === null && composerNote === null}
				<p class="empty-hint">
					Ask about this session’s events — every answer is verified against them, quote by
					quote.
				</p>
			{/if}
		</div>

		<div class="border-t border-line p-3">
			<ChatComposer disabled={composerNote !== null || chat.sending} note={composerNote} {onSend} />
		</div>
	</div>

	<!-- 48px card stub: one element (identity + action + unread slot). -->
	<div class="chat-stub absolute inset-0 flex flex-col items-center py-2" inert={!collapsed}>
		<KeyHint
			label="Chat column"
			keys="Ctrl+."
			side="left"
			class="primitive-icon-button mt-0.5 shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
			onclick={onToggle}
		>
			<span class="relative inline-flex">
				<IconMessage size={18} stroke-width={1.8} />
				{#if unread}
					<span
						class="absolute -top-0.5 -right-0.5 h-[7px] w-[7px] rounded-full bg-orange"
						aria-hidden="true"
					></span>
				{/if}
			</span>
		</KeyHint>
	</div>
</aside>

<style>
	.chat-copy {
		opacity: 1;
		transform: translateX(0);
		transition:
			opacity var(--chat-copy-duration) ease-out,
			transform var(--chat-copy-duration) var(--chat-easing);
	}

	.chat-stub {
		pointer-events: none;
		opacity: 0;
		transition: opacity var(--chat-copy-duration) ease-out;
	}

	[data-chat-collapsed='true'] .chat-copy {
		pointer-events: none;
		opacity: 0;
		transform: translateX(var(--chat-copy-offset));
	}

	[data-chat-collapsed='true'] .chat-stub {
		pointer-events: auto;
		opacity: 1;
		transition-delay: calc(var(--chat-copy-duration) / 2);
	}

	.chat-scroll {
		font-size: 13px;
		line-height: 1.6;
	}

	.user-bubble {
		align-self: flex-end;
		max-width: 85%;
		padding: 10px 12px;
		border-radius: 12px 12px 4px 12px;
		background: var(--field);
		border: 1px solid var(--line);
		font-size: 12.5px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.assistant {
		display: flex;
		flex-direction: column;
		font-size: 13px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
		/* marked-inline keeps raw newlines in the text; pre-wrap keeps the
		 * model's paragraph breaks visible instead of collapsing them into
		 * one run-on line. */
		white-space: pre-wrap;
	}

	.ungrounded {
		font-size: 13px;
		color: var(--ink-3);
	}
	.ungrounded-ctx {
		color: var(--ink-2);
	}

	.empty-hint {
		margin: auto 0;
		text-align: center;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--ink-3);
		max-width: 240px;
		align-self: center;
	}

	.error-bubble {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--red-tint);
		border: 1px solid color-mix(in oklch, var(--red) 30%, transparent);
	}
	.error-line {
		font-size: 12px;
		color: var(--ink);
		margin: 0;
		overflow-wrap: anywhere;
	}
	.error-partial {
		font-size: 12px;
		color: var(--ink-3);
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.error-retry {
		align-self: flex-start;
		font-size: 11.5px;
		font-weight: 550;
		color: var(--red);
		border: none;
		background: none;
		padding: 0;
	}

	/* Pending-shimmer pill (ruling 5): a complete-but-unverified marker
	 * renders as neutral motion, never carrying a color it hasn't earned —
	 * the paired color arrives only with the verified pill at settle. */
	.pending-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 16px;
		padding: 0 5px;
		border-radius: 5px;
		vertical-align: -2px;
		background: var(--hover);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 11px;
		line-height: 1;
		color: var(--ink-3);
		overflow: hidden;
		position: relative;
	}
	/* pending-shimmer is the shared keyframe in app.css (issue #82 extraction —
	 * one motion vocabulary, one global reduced-motion floor owns it). */
	.pending-pill::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, transparent, oklch(1 0 0 / 0.55), transparent);
		animation: pending-shimmer 1.4s ease-in-out infinite;
	}
	:global(.dark) .pending-pill::after {
		background: linear-gradient(90deg, transparent, oklch(1 0 0 / 0.14), transparent);
	}
</style>
