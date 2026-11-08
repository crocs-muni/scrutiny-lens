<script lang="ts">
	/* Test fixture: the real bar inside the app's single Tooltip.Provider
	 * (routes/+layout.svelte), mirroring how the page mounts it. */
	import { Tooltip } from 'bits-ui';
	import BreadcrumbBar from '$lib/components/shell/BreadcrumbBar.svelte';
	import type { AscendTarget, NavAction, NavCrumb, NavTrail } from '$lib/nav';

	interface Props {
		rootLabel?: 'Results';
		crumbs: NavCrumb[];
		up: AscendTarget | null;
		upLabel?: string;
		live?: string;
		meta?: string;
	}

	let {
		rootLabel = 'Results',
		crumbs,
		up,
		upLabel = '',
		live = '',
		meta = ''
	}: Props = $props();

	let events = $state<string[]>([]);
	const trail: NavTrail = $derived({
		rootLabel,
		crumbs,
		up,
		upLabel:
			upLabel ||
			(up === 'previous-anchor'
				? 'Back to previous card'
				: up === 'results'
					? 'Back to results'
					: ''),
		live
	});
	let bar = $state<{ focusAfterAscend: () => void } | null>(null);
</script>

<Tooltip.Provider delayDuration={0}>
	<BreadcrumbBar
		bind:this={bar}
		{trail}
		{meta}
		onCrumb={(action: NavAction) => events.push(`crumb:${action}`)}
		onAscend={(target) => events.push(`ascend:${target}`)}
	/>
	<!-- Focus probe for focusAfterAscend(); scoped out of the bar so the
		bar's own control count stays meaningful. -->
	<button type="button" data-testid="focus-ascend" onclick={() => bar?.focusAfterAscend()}>
		focus
	</button>
	<output data-testid="events">{events.join(',')}</output>
</Tooltip.Provider>
