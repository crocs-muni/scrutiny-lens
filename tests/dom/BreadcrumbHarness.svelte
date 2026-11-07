<script lang="ts">
	/* Test fixture: the real bar inside the app's single Tooltip.Provider
	 * (routes/+layout.svelte), mirroring how the page mounts it. */
	import { Tooltip } from 'bits-ui';
	import BreadcrumbBar from '$lib/components/shell/BreadcrumbBar.svelte';
	import type { AscendTarget, NavCrumb, NavTrail } from '$lib/nav';

	interface Props {
		crumbs: NavCrumb[];
		up: AscendTarget | null;
		meta?: string;
	}

	let { crumbs, up, meta = '' }: Props = $props();

	let events = $state<string[]>([]);
	const trail: NavTrail = $derived({ crumbs, up });
	let bar = $state<{ focusAfterAscend: () => void } | null>(null);
</script>

<Tooltip.Provider delayDuration={0}>
	<BreadcrumbBar
		bind:this={bar}
		{trail}
		{meta}
		onCrumb={(level) => events.push(`crumb:${level}`)}
		onAscend={(target) => events.push(`ascend:${target}`)}
	/>
	<!-- Focus probe for focusAfterAscend(); scoped out of the bar so the
		bar's own control count stays meaningful. -->
	<button type="button" data-testid="focus-ascend" onclick={() => bar?.focusAfterAscend()}>
		focus
	</button>
	<output data-testid="events">{events.join(',')}</output>
</Tooltip.Provider>
