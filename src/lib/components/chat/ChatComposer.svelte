<script lang="ts">
	/* Chat composer (issue #30) — Enter sends, Shift+Enter newlines. A
	 * disabled composer always says WHY (ruling 6: no silent dead ends) via
	 * the `note` line under it; the honest disabled states (no key, session
	 * events not in memory) are computed by the column. */

	import { IconArrowUp } from '@tabler/icons-svelte';

	interface Props {
		disabled: boolean;
		/** Honest disabled reason — rendered under the composer. */
		note?: string | null;
		placeholder?: string;
		onSend: (question: string) => void;
	}

	let { disabled, note = null, placeholder = 'Ask about the session…', onSend }: Props = $props();

	let draft = $state('');

	function send(): void {
		const q = draft.trim();
		if (q === '' || disabled) return;
		draft = '';
		onSend(q);
	}

	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}
</script>

<div class="composer-wrap">
	<form
		class="composer"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		<textarea
			bind:value={draft}
			{onkeydown}
			rows="2"
			{disabled}
			aria-label="Chat question"
			{placeholder}
			class="composer-input"
		></textarea>
		<button
			type="submit"
			aria-label="Send"
			disabled={disabled || draft.trim() === ''}
			class="composer-send"
		>
			<IconArrowUp size={16} stroke-width={2.2} />
		</button>
	</form>
	{#if note}
		<p class="composer-note">{note}</p>
	{/if}
</div>

<style>
	.composer-wrap {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.composer {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		border-radius: 10px;
		background: var(--inset);
		border: 1px solid var(--line);
		padding: 8px 8px 8px 12px;
		transition: border-color 150ms;
	}
	.composer:focus-within {
		border-color: var(--line-strong);
	}
	.composer-input {
		flex: 1;
		min-width: 0;
		min-height: 24px;
		max-height: 120px;
		resize: none;
		background: transparent;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink);
		outline: none;
		field-sizing: content;
	}
	.composer-input::placeholder {
		color: var(--ink-3);
	}
	.composer-input:disabled {
		opacity: 0.55;
	}
	.composer-send {
		flex: 0 0 28px;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-control, 7px);
		border: none;
		background: var(--ink);
		color: var(--surface);
		transition: background-color 150ms;
	}
	.composer-send:disabled {
		background: var(--hover-2);
		color: var(--ink-3);
	}
	.composer-note {
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-3);
		margin: 0;
		padding: 0 4px;
	}
</style>
