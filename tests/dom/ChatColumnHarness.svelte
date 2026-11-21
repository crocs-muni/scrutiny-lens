<script lang="ts">
	/* DOM-test wrapper for ChatColumn (issue #134). The column's KeyHint needs
	 * the app's one Tooltip.Provider (routes/+layout.svelte), and the chat
	 * store is module state the test seeds before mounting. */
	import { Tooltip } from 'bits-ui';
	import ChatColumn from '$lib/components/shell/ChatColumn.svelte';

	const noop = (): void => {};
</script>

<Tooltip.Provider>
	<ChatColumn collapsed={false} onToggle={noop} grounded={true} onSend={noop} onOpenDossier={noop} />
</Tooltip.Provider>
