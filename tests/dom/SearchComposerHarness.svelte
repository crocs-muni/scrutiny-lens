<script lang="ts">
	/* Test fixture: the real composer inside the app's single Tooltip.Provider
	 * (routes/+layout.svelte), mirroring how the page mounts it. */
	import { Tooltip } from 'bits-ui';
	import SearchComposer from '$lib/components/ui/SearchComposer.svelte';

	let {
		on_submit = () => {},
		on_settings = () => {}
	}: { on_submit?: (q: string) => void; on_settings?: () => void } = $props();
</script>

<Tooltip.Provider delayDuration={0}>
	<SearchComposer onSubmit={on_submit} onSettings={on_settings} />
</Tooltip.Provider>
