<script lang="ts">
	/* SEARCH COMPOSER — J1 hero input (design board BIBLE §1, issue #37).
	 *
	 * In-app composition, not canon PromptBar: canon's composer carries
	 * chat-app machinery (model menu, @-mentions, takeover) this surface
	 * does not model — per spec §9, in-app compositions are built in-app
	 * from primitives. Owner ruling 2026-09-03: plain text, no identifier
	 * chips; prefix detection stays invisible in the pipeline pre-pass (§3).
	 *
	 * Enter submits, Shift+Enter is a newline; the arrow button mirrors
	 * Enter. Placeholder copy is fixed by the design board. */

	import { IconArrowUp } from '@tabler/icons-svelte';
	import KeyHint from '../shell/KeyHint.svelte';

	interface Props {
		onSubmit: (question: string) => void;
	}

	let { onSubmit }: Props = $props();

	let value = $state('');

	function submit() {
		const question = value.trim();
		if (question === '') return;
		onSubmit(question);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
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
		placeholder="Ask in plain English, or drop a CVE, GHSA, package URL, cert id…"
		class="block w-full resize-none text-[14px] text-ink placeholder:text-ink-2"
	></textarea>
	<div class="mt-3.5 flex items-center justify-end">
		<KeyHint
			label="Search"
			keys="Enter"
			side="left"
			class="flex h-9 w-9 items-center justify-center rounded-[9px] bg-accent text-white {value.trim() === '' ? 'cursor-default opacity-40' : ''}"
			onclick={submit}
		>
			<IconArrowUp size={15} stroke={2.4} />
		</KeyHint>
	</div>
</div>
