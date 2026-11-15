<script lang="ts">
	/* Test fixture: the app shell's shape — the trigger sits in the
	 * [inert] container while the dialog is open (+page.svelte:722). The
	 * dialog's focus-return cleanup must survive that ordering. */
	import { Tooltip } from 'bits-ui';
	import SettingsDialog from '$lib/components/shell/SettingsDialog.svelte';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();
	let open = $state(true);
</script>

<div inert={open ? true : undefined}>
	<button id="settings-trigger">Open settings</button>
</div>

<Tooltip.Provider>
	{#if open}
		<SettingsDialog
			onClose={() => {
				open = false;
				onClose();
			}}
		/>
	{/if}
</Tooltip.Provider>
