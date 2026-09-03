<script lang="ts">
	/* SEARCH COMPOSER — J1 hero input (design board BIBLE §1, issue #37).
	 *
	 * VENDORED MUTATION of canon PromptBar
	 * (beautiful-ui-svelte/src/components/PromptBar/PromptBar.svelte), tier
	 * two of the spec §9 sourcing rule: PromptBar's control surface is
	 * demo-dressed (@/sources menu, /commands, model picker, dictation,
	 * attachments, glimm sweep) and spec §9 forbids mutating CANON for app
	 * needs — so this app-owned copy keeps the composer's proven idioms
	 * (bg-transparent auto-wrap textarea, Enter/Shift+Enter, IME-composition
	 * guard, active:scale send) and drops everything else. The container
	 * keeps the design board's own chrome (strong border + inset shadow);
	 * canon convergence is tracked at aykoooo/beautiful-ui-svelte#1
	 * ("hero-tall" variant).
	 *
	 * Owner ruling 2026-09-03: plain text, no identifier chips; prefix
	 * detection stays invisible in the pipeline pre-pass (spec §3). */

	import { IconArrowUp } from '@tabler/icons-svelte';
	import KeyHint from '../shell/KeyHint.svelte';

	interface Props {
		onSubmit: (question: string) => void;
	}

	let { onSubmit }: Props = $props();

	let value = $state('');

	const canSend = $derived(value.trim() !== '');

	function submit() {
		if (!canSend) return;
		onSubmit(value.trim());
	}

	function onkeydown(event: KeyboardEvent) {
		// canon's guard: never submit mid-IME-composition (Enter picks a
		// candidate there, it does not send).
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			submit();
		}
	}
</script>

<div
	class="rounded-[12px] border border-line-strong bg-surface p-4 shadow-[inset_0_1px_2px_oklch(0_0_0/0.06)]"
>
	<!-- svelte-ignore a11y_autofocus — the hero composer IS the page's
		purpose (spotlight pattern); focus lands where the only action is. -->
	<textarea
		bind:value
		{onkeydown}
		rows="2"
		autofocus
		aria-label="Question"
		placeholder="Ask in plain English, or drop a CVE, GHSA, package URL, cert id…"
		class="block w-full resize-none bg-transparent text-[14px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-2"
	></textarea>
	<div class="mt-3.5 flex items-center justify-end">
		<KeyHint
			label="Search"
			keys="Enter"
			side="left"
			class="flex h-9 w-9 items-center justify-center rounded-[9px] bg-accent text-white transition-transform duration-150 enabled:active:scale-[0.94] {canSend
				? ''
				: 'cursor-default opacity-40'}"
			onclick={submit}
		>
			<IconArrowUp size={15} stroke={2.4} />
		</KeyHint>
	</div>
</div>
