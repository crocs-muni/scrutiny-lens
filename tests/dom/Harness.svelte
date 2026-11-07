<script lang="ts">
	/* Test fixture: the real provider wraps one KeyHint call shape per
	 * `variant`, mirroring the shapes the app uses (see KeyHint header). */
	import { Tooltip } from 'bits-ui';
	import KeyHint from '$lib/components/shell/KeyHint.svelte';
	import SharePopover from '$lib/components/shell/SharePopover.svelte';
	import type { NostrEvent } from 'nostr-tools';

	type Variant =
		| 'icon'
		| 'text'
		| 'value'
		| 'span'
		| 'link'
		| 'hover-only'
		| 'share'
		| 'disabled'
		| 'siblings';

	interface Props {
		variant: Variant;
		value?: string;
	}

	let { variant, value = '' }: Props = $props();

	const subject: NostrEvent = {
		id: 'a'.repeat(64),
		pubkey: 'b'.repeat(64),
		created_at: 1_700_000_000,
		kind: 30078,
		tags: [],
		content: '',
		sig: 'c'.repeat(128)
	};
</script>

<Tooltip.Provider delayDuration={0}>
	{#if variant === 'icon'}
		<KeyHint label="Chat column" keys="Ctrl+.">icon</KeyHint>
	{:else if variant === 'text'}
		<KeyHint label="Home" nameless>
			{#snippet trigger({ props })}
				<button type="button" {...props}>Scrutiny Lens</button>
			{/snippet}
		</KeyHint>
	{:else if variant === 'value'}
		<KeyHint nameless>
			{#snippet content()}
				<span class="font-mono break-all">{value}</span>
			{/snippet}
			{#snippet trigger({ props })}
				<span {...props} role="button">clipped…</span>
			{/snippet}
		</KeyHint>
	{:else if variant === 'span'}
		<button type="button" data-testid="parent">
			<KeyHint label="Retry">
				{#snippet trigger({ props })}
					<span {...props} role="button">retry</span>
				{/snippet}
			</KeyHint>
		</button>
	{:else if variant === 'link'}
		<KeyHint label="Open file in a new tab" nameless>
			{#snippet trigger({ props })}
				<a {...props} href="https://example.test/f.pdf">Open</a>
			{/snippet}
		</KeyHint>
	{:else if variant === 'hover-only'}
		<KeyHint hoverOnly nameless label="Records bound to this record">
			{#snippet trigger({ props })}
				<span {...props}>3 metadata</span>
			{/snippet}
		</KeyHint>
	{:else if variant === 'siblings'}
		<!-- GraphNode shape: the title tip and the chip tip are siblings inside
			a card, so each owns its own pointer-enter. -->
		<div data-testid="card">
			<KeyHint hoverOnly nameless label="Full title">
				{#snippet trigger({ props })}
					<div {...props}>Title</div>
				{/snippet}
			</KeyHint>
			<KeyHint hoverOnly nameless label="Publisher">
				{#snippet trigger({ props })}
					<span {...props}>Chip</span>
				{/snippet}
			</KeyHint>
		</div>
	{:else if variant === 'disabled'}
		<KeyHint label="Zoom in" disabled>icon</KeyHint>
	{:else}
		<SharePopover {subject} />
	{/if}
</Tooltip.Provider>
