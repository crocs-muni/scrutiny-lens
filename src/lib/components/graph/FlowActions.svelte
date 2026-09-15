<script lang="ts">
	/* FLOW ACTION BRIDGE (#29b) — the toolbar strip lives in the PROVIDER's
	 * scope for chrome reasons (G1 draws it above the canvas), but
	 * useSvelteFlow() is only trustworthy in the FLOW's OWN scope: SvelteFlow
	 * hot-swaps the provider store on mount (SvelteFlow.svelte:105), so a
	 * provider-child destructuring the hook at init binds a dead store after
	 * any remount ({#key} root change, HMR) while this child of <SvelteFlow>
	 * always resolves the live one. It renders nothing — it registers the
	 * three viewport actions upward on ready. */

	import { useSvelteFlow } from '@xyflow/svelte';
	import { FIT_OPTIONS } from '$lib/graph/subject-graph';

	export interface FlowViewportActions {
		zoomIn: () => Promise<boolean>;
		zoomOut: () => Promise<boolean>;
		fit: () => Promise<boolean>;
	}

	interface Props {
		onReady: (actions: FlowViewportActions) => void;
	}
	let { onReady }: Props = $props();

	const sf = useSvelteFlow();
	$effect(() => {
		onReady({
			// Bare calls — scaleBy's options.duration path no-ops in 1.6.5
			// (native Controls also calls bare).
			zoomIn: () => sf.zoomIn(),
			zoomOut: () => sf.zoomOut(),
			fit: () => sf.fitView(FIT_OPTIONS)
		});
	});
</script>
