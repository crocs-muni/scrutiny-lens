<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { fetchSessionEvents } from '$lib/session/fetcher.js';
	import type { GraphNode, NostrEvent, Session } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';
	import GraphCanvas from '$lib/components/graph/GraphCanvas.svelte';
	import NodeDetailDrawer from '$lib/components/graph/NodeDetailDrawer.svelte';
	import ChatPanel from '$lib/components/graph/ChatPanel.svelte';
	import { Plus, X, Loader2 } from '@lucide/svelte';

	let id = $derived($page.params.id ?? '');
	let session = $state<Session | undefined>(sessionStore.active);
	let aiNodeMap = $state<Map<string, AIGraphNode>>(new Map());
	let selectedNode = $state<GraphNode | null>(null);
	let followups = $state<string[]>([]);
	let loadingNodes = $state(true);
	let showDeleted = $state(true);

	let chatEvents = $derived(session?.events ?? []);
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
			session = opened;
			await generateNodes(opened.events);
			await loadFollowups(opened.events);
		} else {
			session = sessionStore.active;
		}
	});

	async function generateNodes(events: NostrEvent[]) {
		loadingNodes = true;
		try {
			const res = await fetch('/api/ai/nodes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ events })
			});
			const data = await res.json();
			if (data.ok) {
				const map = new Map<string, AIGraphNode>();
				for (const n of data.result) map.set(n.eventId, n);
				aiNodeMap = map;
			}
		} catch {
			// degrade gracefully
		} finally {
			loadingNodes = false;
		}
	}

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
			followups = ['Show patch history', 'Compare EAL levels', 'Which events are archived?'];
		}
	}

	function selectNode(node: GraphNode) {
		selectedNode = node;
	}

	function closeNode() {
		selectedNode = null;
	}

	async function closeSession(sid: string) {
		await sessionStore.remove(sid);
		goto('/');
	}
</script>

<div class="flex h-screen w-full overflow-hidden">
	<!-- Left rail -->
	<aside class="flex w-[248px] flex-col border-r border-border bg-surface p-3">
		<div class="flex h-11 items-center gap-2 px-2">
			<div class="h-6 w-6 rounded bg-primary"></div>
			<span class="text-sm font-semibold">Scrutiny Lens</span>
		</div>
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
				onSelect={selectNode}
				onToggleDeleted={() => {
					showDeleted = !showDeleted;
				}}
			/>
			{/if}
		</div>
		<NodeDetailDrawer node={selectedNode} ai={selectedNode ? aiNodeMap.get(selectedNode.id) ?? null : null} patches={selectedNodePatches} onClose={closeNode} />
	</section>

	<!-- Chat -->
	<ChatPanel events={chatEvents} rootSummary={chatRootSummary} questions={followups} />
</div>
