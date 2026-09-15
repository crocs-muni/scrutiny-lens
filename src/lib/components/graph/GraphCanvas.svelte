<script lang="ts">
	/* GRAPH CANVAS (#29b) — the ego graph over the session's admitted store,
	 * on @xyflow/svelte (ruling 1). All ten rulings land here:
	 *
	 *  - Ego scope (2): the fixed root hub + admitted neighbors + shadowed
	 *    multihop ends; deriveEgo owns placement, this file owns painting.
	 *  - Fixed root, free selection (4): clicks never move the layout; the
	 *    {#key} on the root (in +page) remounts the flow when a NEW root
	 *    anchors, so fitView frames one fresh map per anchor.
	 *  - Drawer-only click (6) / empty-pane deselect (7): node click →
	 *    onSelect (the same path the results cards take), pane click →
	 *    onDeselect. xyflow's own selection is disabled — the accent ring is
	 *    data-driven (ruling 2/#29a), never a canvas-local truth.
	 *  - Admitted-only expansion (8): the +N badge's dbl-click bubbles to
	 *    investigation.expandHub; every rendered edge is backed by an
	 *    admitted event by construction (deriveEgo).
	 *  - Chain word (9) renders on the node; retraction and Show-deleted (10)
	 *    filter in deriveEgo, the switch lives in the toolbar.
	 *  - Citation ring: the chat's registry pins (n ↔ eventId) are mapped to
	 *    palette slots; spotlight hover lights the matching node and forces
	 *    full detail (N4). The registry is non-reactive internally, so the
	 *    map rebuilds off chat.messages — pins only change with a turn. */

	import {
		SvelteFlow,
		SvelteFlowProvider,
		Background,
		BackgroundVariant,
		MarkerType,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '../chat/citations.css';
	import GraphNode, { type GraphNodeData } from './GraphNode.svelte';
	import CanvasToolbar from './CanvasToolbar.svelte';
	import FlowActions, { type FlowViewportActions } from './FlowActions.svelte';
	import { deriveEgo, FIT_OPTIONS } from '$lib/graph/ego';
	import { investigation } from '$lib/investigation.svelte';
	import { VERB_CLIP } from '$lib/dossier';
	import { clipMiddle } from '$lib/text';
	import { shell } from '$lib/shell.svelte';
	import { chat } from '$lib/chat.svelte';
	import { CITATION_SLOTS } from '$lib/ai/citationRegistry';
	import { spotlight } from '../chat/spotlight.svelte';
	import type { NostrEvent } from '$lib/fabric';
	import type { ProductCard } from '$lib/pipeline/cards';

	interface Props {
		/** The session's admitted set (ADR 0001 — never the facet-filtered view). */
		events: NostrEvent[];
		cards: ProductCard[];
		/** The ego anchor (investigation.canvasRootId); null → honest empty. */
		root: string | null;
		selectedEventId: string | null;
		onSelect: (id: string) => void;
		onDeselect: () => void;
	}
	let { events, cards, root, selectedEventId, onSelect, onDeselect }: Props = $props();

	const nodeTypes = { scrutiny: GraphNode };
	/** Live viewport actions, registered from inside the flow (see
	 * FlowActions: provider-scope init binds a dead store on remount). */
	let viewport = $state<FlowViewportActions | null>(null);

	const ego = $derived.by(() => {
		if (root === null) return { nodes: [], edges: [] };
		return deriveEgo(events, root, {
			showDeleted: shell.showDeleted,
			expanded: new Set(investigation.expandedHubs),
			cards
		});
	});

	// SvelteFlow's bind:nodes needs writable fields; the $effect copies the
	// derived view in whenever any input (ego, selection, spotlight, pins)
	// changes. One-directional: the flow never writes back (no dragging,
	// no connects), so there is no sync loop to guard.
	//
	// chat.messages is touched so new pins re-run the copy: the registry's
	// maps are non-reactive internals and pin only on a settled turn.
	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	$effect(() => {
		void chat.messages.length;
		const lit = new Set(spotlight.active);
		nodes = ego.nodes.map((n) => {
			const citeN = chat.registry.numberFor(n.id) ?? null;
			const citationIndex = citeN === null ? null : (citeN - 1) % CITATION_SLOTS;
			return {
				id: n.id,
				type: 'scrutiny',
				position: { x: n.x, y: n.y },
				data: {
					...n,
					selected: n.id === selectedEventId,
					citationIndex,
					citationLit: citeN !== null && lit.has(citeN),
					onSelect,
					onExpand: (target: string) => investigation.expandHub(target)
				} satisfies GraphNodeData
			};
		});
		edges = ego.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			// The binding's verb, clipped (N1⑦) — corpus bindings carry
			// machine sentences, which at full length paint a canvas-spanning
			// bar where an edge label belongs (owner screenshot 2026-09-14);
			// '' stays unlabeled.
			label: e.label === '' ? undefined : clipMiddle(e.label, VERB_CLIP),
			sourceHandle: `s-${e.sourceHandle}`,
			targetHandle: `t-${e.targetHandle}`,
			// Arrows at the destination end (N1⑦ crow's-foot rule); shadow
			// edges wear G1's amber dashed multihop language.
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 14,
				height: 14,
				color: e.shadowed ? 'var(--orange)' : 'var(--line-strong)'
			},
			style: e.shadowed
				? 'stroke: var(--orange); stroke-dasharray: 4 5; stroke-width: 1.8;'
				: 'stroke: var(--line-strong); stroke-width: 1.8;',
			// Halo, not a chip: a fill-rect labelBgStyle reads as an unthemed
			// white bar (owner report 2026-09-14); paint-order stroke keeps
			// the verb legible on the dots at every zoom.
			labelStyle: `font-family: var(--font-mono-face); font-size: 10px; fill: ${e.shadowed ? 'var(--orange)' : 'var(--ink-2)'}; paint-order: stroke; stroke: var(--canvas); stroke-width: 4px;`
		}));
	});
</script>

{#if root === null}
	<!-- honest empty (ruling 7 vocabulary): no placeholder graph, ever -->
	<div class="flex min-h-0 w-full flex-1 items-center justify-center">
		<p class="max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
			Open a result to see its graph — the canvas grows from admitted bindings, never from
			guesses.
		</p>
	</div>
{:else}
	<div
		class="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface"
	>
		<SvelteFlowProvider>
			<CanvasToolbar actions={viewport} />
			<div class="min-h-0 flex-1">
				<SvelteFlow
					bind:nodes
					bind:edges
					{nodeTypes}
					fitView
					fitViewOptions={FIT_OPTIONS}
					minZoom={0.25}
					maxZoom={1.6}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					zoomOnDoubleClick={false}
					onpaneclick={() => onDeselect()}
					aria-label="Session graph"
				>
					<Background variant={BackgroundVariant.Dots} gap={22} size={1} bgColor="var(--line-strong)" />
					<FlowActions onReady={(a) => (viewport = a)} />
				</SvelteFlow>
			</div>
		</SvelteFlowProvider>
	</div>
{/if}
