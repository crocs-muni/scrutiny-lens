<script lang="ts">
	/* KEY FIELD — vendored app atom (spec §9 two-tier rule; "KeyField" is in
	 * the §9 new-components list): secret input + reveal toggle. App anatomy
	 * canon does not model — the copy is PERMANENT app code, organized
	 * shadcn-style beside the other vendored atoms (SidebarRecents header
	 * states the same contract).
	 *
	 * The key itself is machine-made, so it renders mono (spec §9 writing
	 * rule). */

	import { IconEye, IconEyeOff } from '@tabler/icons-svelte';

	interface Props {
		id?: string;
		value: string;
		placeholder?: string;
		'aria-label'?: string;
		/** Fired on every keystroke — the caller arms the spec §6 redaction
		 * strip here. The field itself never writes to storage. */
		oninput: (value: string) => void;
	}

	let { id, value, placeholder = 'sk-…', oninput }: Props = $props();

	let revealed = $state(false);
</script>

<div class="flex items-center rounded-control bg-field shadow-hairline transition-shadow duration-150 focus-within:shadow-card">
	<input
		{id}
		type={revealed ? 'text' : 'password'}
		{value}
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		oninput={(event) => oninput(event.currentTarget.value)}
		class="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
	/>
	<button
		type="button"
		tabindex={-1}
		aria-label={revealed ? 'Hide API key' : 'Show API key'}
		onclick={() => (revealed = !revealed)}
		class="primitive-icon-button mr-0.5 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
	>
		{#if revealed}
			<IconEyeOff size={14} stroke-width={2} />
		{:else}
			<IconEye size={14} stroke-width={2} />
		{/if}
	</button>
</div>
