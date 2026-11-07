<script lang="ts">
	/* Test fixture: the real drawer inside the app-wide Tooltip.Provider
	 * (+layout.svelte) it expects — no other shape differs from production. */
	import { Tooltip } from 'bits-ui';
	import DetailDrawer from '$lib/components/shell/DetailDrawer.svelte';
	import type { Dossier } from '$lib/dossier';

	interface Props {
		dossier: Dossier;
	}

	let { dossier }: Props = $props();
</script>

<Tooltip.Provider delayDuration={0}>
	<DetailDrawer
		open
		height={480}
		maxHeight={640}
		{dossier}
		onToggle={() => {}}
		onResize={() => {}}
	/>
</Tooltip.Provider>
