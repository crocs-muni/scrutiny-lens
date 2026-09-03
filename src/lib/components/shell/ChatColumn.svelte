<script lang="ts">
	/* CHAT COLUMN — resident only while a session is open (spec §9); the
	 * parent unmounts it on the search/results views (search/results hide
	 * the column; the J2 board's results-view stub is stale per spec §9).
	 * Collapsed state is a 48px card stub carrying ONE element — the chat
	 * icon as the toggle, unread dot reserved on its corner (owner ruling
	 * 2026-09-03, "B"): board E2's vertical label + decorative bottom icon
	 * read as two competing affordances live. Copy exits first (issue #10
	 * harness rule). Chat content (messages, composer, citations) arrives with the chat
	 * step (spec §11 step 4) — this file is chrome only. */

	import { IconArrowBarToRight, IconMessage } from '@tabler/icons-svelte';
	import KeyHint from './KeyHint.svelte';
	import { COLLAPSE } from '../ui/motion';

	interface Props {
		collapsed: boolean;
		onToggle: () => void;
		/** Unread-activity dot on the collapsed stub's icon; arrives with
		 * the chat step (#30) — reserved now per the stub's closed form. */
		unread?: boolean;
	}

	let { collapsed, onToggle, unread = false }: Props = $props();

	// Width-only 280ms; copy fades in 180ms ahead of it (issue #10).
	const MOTION = {
		expandedWidth: 320,
		collapsedWidth: 48,
		...COLLAPSE
	};
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
		<div class="flex min-h-0 flex-1 items-center justify-center p-4">
			<p class="max-w-56 text-center text-[12.5px] leading-relaxed text-ink-3">
				Grounded answers with verified citations arrive with the chat step (spec §11 step 4).
			</p>
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
</style>
