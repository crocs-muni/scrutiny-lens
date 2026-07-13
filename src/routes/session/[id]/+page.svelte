<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { fetchSessionEvents } from '$lib/session/fetcher.js';
	import type { GraphNode, NostrEvent } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import GraphCanvas from '$lib/components/graph/GraphCanvas.svelte';
	import NodeDetailDrawer from '$lib/components/graph/NodeDetailDrawer.svelte';
	import ChatPanel from '$lib/components/graph/ChatPanel.svelte';
	import { Plus, X, Loader2 } from '@lucide/svelte';

	let id = $derived($page.params.id ?? '');
	// A derived, not a one-time $state snapshot: sessionStore.active is a
	// getter that returns a freshly-hydrated object after every store mutation
	// (toggleExpand/expandToHop/revealNode all end in loadList()), so a plain
	// $state assigned once at mount would silently stop tracking session.events
	// growth after the first expand -- exactly the kind of staleness the new
	// "grounded in visible subgraph" chat scope depends on not having.
	let session = $derived(sessionStore.active);
	let aiNodeMap = $state<Map<string, AIGraphNode>>(new Map());
	// Ids already enriched (or in-flight) so we never resend an event to
	// /api/ai/nodes just because it reappears in a later, bigger batch (e.g.
	// after expanding a node with hundreds of hidden neighbors).
	let enrichedIds = new Set<string>();
	let selectedNode = $state<GraphNode | null>(null);
	let followups = $state<string[]>([]);
	let loadingNodes = $state(true);
	let showDeleted = $state(true);
	let hopLoading = $state(false);

	// Citation hover/click state (see the QandA citation workflow spec):
	// hover only rings a node that's already visible, no reveal/pan; click
	// force-reveals the node (same mechanism as a manual "+" expand),
	// flips Show deleted on if needed, pans the camera to it, and opens its
	// drawer with an "arrived from citation" banner.
	let hoverCitation = $state<{ id: string; n: number } | null>(null);
	let activeCitation = $state<{ id: string; n: number; quote: string; verified: boolean } | null>(null);
	let focusRequest = $state<{ nodeId: string; token: number } | null>(null);
	let focusToken = 0;

	function handleCitationHover(target: { id: string; n: number } | null) {
		if (!target) {
			hoverCitation = null;
			return;
		}
		const visible = sessionStore.graph.nodes.some((n) => n.id === target.id);
		hoverCitation = visible ? target : null;
	}

	async function handleCitationClick(target: { id: string; n: number; quote: string; verified: boolean }) {
		const revealed = await sessionStore.revealNode(target.id);
		if (!revealed) return;

		const gn = sessionStore.graph.nodes.find((n) => n.id === target.id);
		if (!gn) return;

		if (gn.retracted && !showDeleted) showDeleted = true;

		selectedNode = gn;
		activeCitation = target;
		focusRequest = { nodeId: target.id, token: ++focusToken };
	}

	async function handleHopChange(depth: number) {
		hopLoading = true;
		try {
			await sessionStore.expandToHop(depth);
		} finally {
			hopLoading = false;
		}
	}

	// Chat is grounded in the currently VISIBLE subgraph, not the full
	// accumulated event cache -- so it can't cite (or "know about") a node
	// you've collapsed out of view via the hop slider, or hidden via Show
	// deleted. An event counts as visible if it's a currently-visible node's
	// own event, or a binding/patch/deletion event that targets one (via its
	// `e` tags) -- e.g. the binding that explains *why* two visible nodes are
	// connected, or the patch history behind a visible node's "N updates".
	let visibleNodeIds = $derived(
		new Set(sessionStore.graph.nodes.filter((n) => showDeleted || !n.retracted).map((n) => n.id))
	);
	let chatEvents = $derived.by(() => {
		const all = session?.events ?? [];
		const visible = visibleNodeIds;
		return all.filter((e) => visible.has(e.id) || e.tags.some((t) => t[0] === 'e' && visible.has(t[1])));
	});
	// Patch events (scrutiny-patch) aren't graph nodes — they're history for
	// whichever node their `e` tags target (components.md #12).
	let selectedNodePatches = $derived.by(() => {
		if (!selectedNode) return [];
		const targetId = selectedNode.id;
		return (session?.events ?? [])
			.filter(
				(e) =>
					e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-patch') &&
					e.tags.some((t) => t[0] === 'e' && t[1] === targetId)
			)
			.sort((a, b) => a.created_at - b.created_at);
	});
	// Same patch-event shape as selectedNodePatches, but counted per target id
	// up front so every node's card can show a real count instead of a guess.
	let patchCountByNodeId = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const e of session?.events ?? []) {
			if (!e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-patch')) continue;
			for (const t of e.tags) {
				if (t[0] === 'e' && t[1]) counts.set(t[1], (counts.get(t[1]) ?? 0) + 1);
			}
		}
		return counts;
	});
	let chatRootSummary = $derived.by(() => {
		const root = session?.events.find((e) =>
			e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-product')
		);
		if (!root) return 'A SCRUTINY certification event graph.';
		const ids = root.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
		const idStr = ids.join(', ');
		const snippet = root.content.slice(0, 120);
		return `This session contains a Product event ${idStr ? '(' + idStr + ': ' + snippet + ')' : ''}. Other events are metadata, bindings, patches, and deletions connected to it.`;
	});

	onMount(async () => {
		if (!id) return;
		const opened = await sessionStore.open(id, fetchSessionEvents);
		if (opened) {
			await generateNodes(opened.events);
			await loadFollowups(opened.events);
		}
	});

	// A single /api/ai/nodes call asks the model to generate structured JSON
	// for every event in the batch before returning anything -- for a big
	// batch (e.g. hundreds of nodes revealed by a hop expansion) that's one
	// huge sequential generation, which is slow. Splitting into small chunks
	// fired concurrently turns that into many small, fast generations running
	// in parallel (wall time ~= the slowest chunk, not the sum of all of
	// them), and titles reveal progressively as each chunk finishes instead of
	// all at once at the end.
	const AI_NODES_CHUNK_SIZE = 15;

	// Only ever POSTs events not already enriched (or in flight). Called once
	// from onMount with the full initial event set, and again from the
	// $effect below whenever sessionStore.graph reveals new nodes (e.g. after
	// an expand) -- each call only sends the delta, keeping the request size
	// bounded regardless of how large the session grows.
	async function generateNodes(events: NostrEvent[]) {
		const toFetch = events.filter((e) => !enrichedIds.has(e.id));
		if (toFetch.length === 0) return;
		for (const e of toFetch) enrichedIds.add(e.id);

		const chunks: NostrEvent[][] = [];
		for (let i = 0; i < toFetch.length; i += AI_NODES_CHUNK_SIZE) {
			chunks.push(toFetch.slice(i, i + AI_NODES_CHUNK_SIZE));
		}

		loadingNodes = true;
		try {
			await Promise.all(chunks.map((chunk) => generateNodesChunk(chunk)));
		} finally {
			loadingNodes = false;
		}
	}

	async function generateNodesChunk(chunk: NostrEvent[]): Promise<void> {
		try {
			const res = await fetch('/api/ai/nodes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ events: chunk })
			});
			const data = await res.json();
			if (data.ok) {
				const map = new Map(aiNodeMap);
				for (const n of data.result) map.set(n.eventId, n);
				aiNodeMap = map;
			} else {
				for (const e of chunk) enrichedIds.delete(e.id);
			}
		} catch {
			// degrade gracefully, allow retry on the next graph change
			for (const e of chunk) enrichedIds.delete(e.id);
		}
	}

	// Re-enrich whenever the visible graph grows (e.g. sessionStore.toggleExpand
	// merges a node's neighborhood in). Reads only sessionStore.graph.nodes, and
	// generateNodes never writes back to that -- it only touches aiNodeMap/
	// enrichedIds -- so this can't re-trigger itself (see FlowInner.svelte's
	// displayNodes comment for the pattern being avoided).
	$effect(() => {
		const graphEvents = sessionStore.graph.nodes.map((n) => n.event);
		const newEvents = graphEvents.filter((e) => !enrichedIds.has(e.id));
		if (newEvents.length > 0) generateNodes(newEvents);
	});

	async function loadFollowups(events: NostrEvent[]) {
		try {
			const res = await fetch('/api/ai/followups', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ events })
			});
			const data = await res.json();
			if (data.ok) followups = data.result.questions;
		} catch {
			followups = ['What is this?', 'Is it still active?', 'What is it connected to?'];
		}
	}

	function selectNode(node: GraphNode) {
		selectedNode = node;
		activeCitation = null;
	}

	function closeNode() {
		selectedNode = null;
		activeCitation = null;
	}

	async function closeSession(sid: string) {
		await sessionStore.remove(sid);
		goto('/');
	}
</script>

<div class="flex h-screen w-full overflow-hidden">
	<!-- Left rail -->
	<aside class="flex w-[248px] flex-col border-r border-border bg-surface p-3">
		<a href="/" class="flex h-11 items-center gap-2 rounded-md px-2 hover:bg-secondary">
			<div class="h-6 w-6 rounded bg-primary"></div>
			<span class="text-sm font-semibold">Scrutiny Lens</span>
		</a>
		<a href="/" class="mt-3 flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-secondary">
			<Plus class="h-4 w-4" /> New search
		</a>
		<div class="mt-4 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			<span>Sessions</span>
		</div>
		<div class="mt-2 flex-1 space-y-1 overflow-y-auto">
			{#each sessionStore.sessions as s}
				<a
					href="/session/{s.id}"
					class="group relative block rounded-md px-2.5 py-2 {s.id === id ? 'border border-pri-border bg-accent' : 'hover:bg-secondary'}"
				>
					{#if s.id === id}
						<div class="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-primary"></div>
					{/if}
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0 flex-1">
							<div class="text-[13px] font-medium text-card-foreground truncate">{s.title}</div>
							<div class="text-[11.5px] text-muted-foreground truncate">{s.query}</div>
						</div>
						{#if s.id === id}
							<button
								onclick={(e) => {
									e.preventDefault();
									closeSession(s.id);
								}}
								class="text-muted-foreground hover:text-destructive"
							>
								<X class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</a>
			{/each}
		</div>
	</aside>

	<!-- Graph + drawer -->
	<section class="relative flex flex-1 flex-col">
		<header class="flex h-11 items-center border-b border-border bg-card px-4">
			<h1 class="text-sm font-semibold text-card-foreground">{session?.title ?? 'Session'}</h1>
			<span class="mx-2 text-muted-foreground">·</span>
			<span class="text-xs text-muted-foreground truncate">{session?.query}</span>
			{#if loadingNodes}
				<span class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" /> Generating nodes</span>
			{/if}
		</header>
		<div class="relative flex-1">
			{#if session}
				<GraphCanvas
					graph={sessionStore.graph}
					aiNodes={aiNodeMap}
					selectedId={selectedNode?.id ?? null}
				{showDeleted}
				rootId={sessionStore.active?.rootEventId ?? ''}
				expandedNodeIds={sessionStore.active?.expandedNodeIds ?? []}
				{patchCountByNodeId}
				hopDepth={sessionStore.active?.hopDepth ?? 1}
				{hopLoading}
				citationRingId={hoverCitation?.id ?? activeCitation?.id ?? null}
				citationRingN={hoverCitation?.n ?? activeCitation?.n ?? null}
				{focusRequest}
				onSelect={selectNode}
				onToggleDeleted={() => {
					showDeleted = !showDeleted;
				}}
				onToggleExpand={(nodeId) => sessionStore.toggleExpand(nodeId)}
				onHopChange={handleHopChange}
			/>
			{/if}
		</div>
		<NodeDetailDrawer
			node={selectedNode}
			ai={selectedNode ? aiNodeMap.get(selectedNode.id) ?? null : null}
			patches={selectedNodePatches}
			arrivedFromCitation={selectedNode && activeCitation?.id === selectedNode.id ? activeCitation.n : null}
			citationQuote={selectedNode && activeCitation?.id === selectedNode.id ? activeCitation.quote : null}
			citationVerified={selectedNode && activeCitation?.id === selectedNode.id ? activeCitation.verified : false}
			onClose={closeNode}
		/>
	</section>

	<!-- Chat -->
	<!-- Keyed on the session id: SvelteKit reuses this component instance
	     across param-only navigations (switching sessions in the left rail
	     without a full reload), so without this key the chat transcript AND
	     the citation registry (eventId -> number map) would leak from the
	     previous session into the new one. -->
	{#key id}
		<ChatPanel
			events={chatEvents}
			rootSummary={chatRootSummary}
			questions={followups}
			onCitationHover={handleCitationHover}
			onCitationClick={handleCitationClick}
		/>
	{/key}
</div>
