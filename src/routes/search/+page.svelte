<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import type NDK from '@nostr-dev-kit/ndk';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import type { SearchCard } from '$lib/ai/types.js';
	import type { NostrEvent } from '$lib/session/types.js';
	import ResultCard from '$lib/components/ResultCard.svelte';
	import InterpretationBanner from '$lib/components/InterpretationBanner.svelte';
	import { LayoutList, SlidersHorizontal } from '@lucide/svelte';
	import type { FilterPlan } from '$lib/ai/types.js';
	import {
		connectRelay,
		disconnectRelay,
		searchProducts,
		getProductStats,
		computeFacets,
		type FacetBreakdown,
		type ProductStats
	} from '$lib/search/relay.js';

	let query = $derived($page.url.searchParams.get('q') ?? '');
	let interpretation = $state('');
	let identifiers: string[] = $state([]);
	let events: NostrEvent[] = $state([]);
	let cards: (SearchCard | { skeleton: true; eventId: string })[] = $state([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Facet sidebar + result-card stats: live relay data (see src/lib/search/relay.ts).
	let facets: FacetBreakdown | null = $state(null);
	let totalCount: number | null = $state(null);
	let matchedCount: number | null = $state(null);
	let matchedIsApprox = $state(false);
	let cardStats: Record<string, ProductStats> = $state({});
	let relayOffline = $state(false);

	let ndk: NDK | null = null;

	onMount(async () => {
		if (!query) {
			loading = false;
			return;
		}
		await runSearch();
	});

	onDestroy(() => {
		if (ndk) disconnectRelay(ndk);
	});

	async function runSearch() {
		loading = true;
		error = null;
		cards = [];
		facets = null;
		totalCount = null;
		matchedCount = null;
		cardStats = {};

		let plan: FilterPlan = {
			interpretation: `Searching for “${query}”`,
			filters: [{ mode: 'freetext', search: query, types: [] }]
		};
		try {
			const res = await fetch('/api/ai/query', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query })
			});
			const data = await res.json();
			if (data.ok && data.plan) {
				plan = data.plan as FilterPlan;
			}
		} catch {
			// Degrade gracefully if AI key missing.
		}

		interpretation = plan.interpretation;
		identifiers = plan.filters.filter((f) => f.identifier).map((f) => f.identifier!);

		try {
			// Step 2: load events -- live relay search first, fall back to the demo fixture.
			if (ndk) disconnectRelay(ndk);
			ndk = await connectRelay();
			relayOffline = !ndk;

			if (ndk) {
				try {
					const result = await searchProducts(ndk, plan, query);
					if (result.products.length > 0) {
						events = result.products;
						matchedCount = result.matchedCount;
						matchedIsApprox = result.matchedIsApprox;
						totalCount = result.totalCount;
						facets = computeFacets(result.products);
					} else {
						await loadFixtureEvents();
					}
				} catch (err) {
					console.warn('[search] relay search failed, falling back to fixtures:', err);
					await loadFixtureEvents();
				}
			} else {
				await loadFixtureEvents();
			}

			// Step 3: spawn skeletons then generate cards one-by-one.
			cards = events
				.filter((e) => !e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-binding'))
				.map((e) => ({ skeleton: true, eventId: e.id }));

			for (let i = 0; i < cards.length; i++) {
				const evt = events.find((e) => e.id === cards[i].eventId);
				if (!evt) continue;
				try {
					const res = await fetch('/api/ai/cards', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ event: evt, query })
					});
					const data = await res.json();
					if (data.ok) {
						cards[i] = data.result;
					} else {
						cards[i] = fallbackCard(evt);
					}
				} catch {
					cards[i] = fallbackCard(evt);
				}

				// Fire off the real per-card stats query alongside card resolution.
				if (ndk) {
					getProductStats(ndk, evt.id)
						.then((stats) => {
							cardStats = { ...cardStats, [evt.id]: stats };
						})
						.catch((err) => console.warn('[search] product stats failed:', err));
				}
			}
		} finally {
			loading = false;
		}
	}

	async function loadFixtureEvents() {
		try {
			const fixture = await import('../../../fixtures/demo-graph.json', { with: { type: 'json' } });
			events = fixture.default.events as NostrEvent[];
			const products = events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'scrutiny-product'));
			facets = computeFacets(products);
			matchedIsApprox = false;
		} catch (err) {
			console.warn('[search] fixture fallback failed:', err);
			events = [];
			facets = { scheme: [], eal: [], status: [] };
			error = 'No results from the relay or the demo fixture.';
		}
	}

	function fallbackCard(event: NostrEvent): SearchCard {
		const idents = event.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
		return {
			eventId: event.id,
			title: event.content.split('\n')[0].slice(0, 80),
			badges: idents.length ? idents.slice(0, 2) : [`kind:${event.kind}`],
			snippet: event.content.slice(0, 200)
		};
	}

	async function openGraph(index: number) {
		const card = cards[index];
		if (!card || 'skeleton' in card) return;
		const session = await sessionStore.create(card.title || query, query, events);
		goto(`/session/${session.id}`);
	}
</script>

<div class="flex h-screen w-full">
	<!-- Icon rail -->
	<aside class="flex w-[60px] flex-col items-center border-r border-border bg-surface py-3">
		<div class="h-6 w-6 rounded bg-primary"></div>
		<a href="/" class="mt-6 rounded-md p-2 text-muted-foreground hover:bg-secondary"><LayoutList class="h-5 w-5" /></a>
	</aside>

	<!-- Facet sidebar -->
	<aside class="w-[234px] border-r border-border bg-surface p-4">
		<div class="flex items-center gap-2 text-sm font-semibold">
			<SlidersHorizontal class="h-4 w-4" /> Refine
		</div>
		{#if !facets}
			<div class="mt-4 space-y-4">
				{#each [1, 2, 3] as _}
					<div class="h-16 animate-pulse rounded-md bg-secondary"></div>
				{/each}
			</div>
		{:else}
			<div class="mt-4 space-y-4">
				<div>
					<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheme</h4>
					<div class="mt-2 space-y-1.5">
						{#each facets.scheme as facet, i}
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={i === 0} class="rounded border-border text-primary" />
								{facet.value}
								<span class="ml-auto font-mono text-xs text-muted-foreground">{facet.count}</span>
							</label>
						{:else}
							<p class="text-xs text-muted-foreground">No scheme data</p>
						{/each}
					</div>
				</div>
				<div>
					<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">EAL level</h4>
					<div class="mt-2 flex flex-wrap gap-1">
						{#each facets.eal as facet, i}
							<span
								class="rounded-full px-2 py-0.5 text-xs {i === 0
									? 'bg-primary text-primary-foreground'
									: 'border border-border bg-card text-muted-foreground'}"
							>
								{facet.value} <span class="font-mono">{facet.count}</span>
							</span>
						{:else}
							<p class="text-xs text-muted-foreground">No EAL data</p>
						{/each}
					</div>
				</div>
				<div>
					<h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h4>
					<div class="mt-2 space-y-1.5">
						{#each facets.status as facet, i}
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" checked={i === 0} class="rounded border-border text-primary" />
								<span class="h-2 w-2 rounded-full {facet.value === 'Active' ? 'bg-success' : 'bg-muted-foreground'}"
								></span>
								{facet.value}
								<span class="ml-auto font-mono text-xs text-muted-foreground">{facet.count}</span>
							</label>
						{:else}
							<p class="text-xs text-muted-foreground">No status data</p>
						{/each}
					</div>
				</div>
			</div>
		{/if}
	</aside>

	<!-- Results -->
	<main class="flex flex-1 flex-col bg-background">
		<header class="border-b border-border bg-card px-6 py-4">
			<div class="text-xs text-muted-foreground">Results</div>
			<div class="mt-1 flex items-baseline gap-2">
				<h2 class="text-[22px] font-semibold text-card-foreground">
					{matchedCount ?? cards.length}{matchedIsApprox ? '+' : ''} certificates match
				</h2>
				{#if totalCount !== null}
					<span class="text-sm text-muted-foreground">of {totalCount.toLocaleString()} total</span>
				{/if}
			</div>
			{#if relayOffline}
				<p class="mt-1 text-xs text-destructive">Relay unreachable — showing demo fixture data.</p>
			{/if}
		</header>

		<div class="flex-1 overflow-y-auto p-6">
			{#if loading && cards.length === 0}
				<div class="mb-6">
					<InterpretationBanner {interpretation} {identifiers} step="traverse" />
				</div>
				<div class="space-y-4">
					{#each [1, 2, 3] as _}
						<div class="h-40 animate-pulse rounded-[var(--radius-lg)] bg-secondary"></div>
					{/each}
				</div>
			{:else}
				{#if interpretation}
					<div class="mb-6">
						<InterpretationBanner {interpretation} {identifiers} step="traverse" />
					</div>
				{/if}

				{#if error}
					<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>
				{/if}

				<div class="space-y-4">
					{#each cards as card, i}
						{#if 'skeleton' in card}
							<div class="h-40 animate-pulse rounded-[var(--radius-lg)] bg-secondary"></div>
						{:else}
							<ResultCard {card} primary={i === 0} onOpen={() => openGraph(i)} stats={cardStats[card.eventId]} />
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</main>
</div>
