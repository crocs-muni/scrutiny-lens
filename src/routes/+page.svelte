<script lang="ts">
	/* APP SHELL (issue #10, spec §9): three retractable columns —
	 * frameless sessions rail · center canvas swapping search → results →
	 * session (results arrives with the query pipeline, spec §11 step 2)
	 * with the DetailDrawer below the canvas · chat column resident only
	 * while a session is open. */

	import { Tooltip } from 'bits-ui';
	import { handleShellKeydown, shell } from '$lib/shell.svelte';
	import { investigation } from '$lib/investigation.svelte';
	import { settings } from '$lib/settings.svelte';
	import SearchHero from '$lib/components/ui/SearchHero.svelte';
	import TaskTrace from '$lib/components/ui/TaskTrace.svelte';
	import ResultCard from '$lib/components/ui/ResultCard.svelte';
	import FacetRail from '$lib/components/ui/FacetRail.svelte';
	import NoticeBanner from '$lib/components/ui/NoticeBanner.svelte';
	import ResultsEmpty from '$lib/components/ui/ResultsEmpty.svelte';
	import ResultsError from '$lib/components/ui/ResultsError.svelte';
	import { cohortLine } from '$lib/pipeline/cards';
	import { filteredEvents, visibleCards } from '$lib/results';
	import SidebarRecents from '$lib/components/ui/SidebarRecents.svelte';
	import DetailDrawer from '$lib/components/shell/DetailDrawer.svelte';
	import ChatColumn from '$lib/components/shell/ChatColumn.svelte';
	import SettingsDialog from '$lib/components/shell/SettingsDialog.svelte';

	let centerHeight = $state(0);
	// The drawer may grow until the canvas keeps a usable strip.
	const drawerMax = $derived(Math.max(240, centerHeight - 120));

	// — Results surface derivations (#38) —
	const viewCards = $derived.by(() => {
		const session = investigation.result;
		if (session === null) return [];
		return visibleCards(session.admitted, investigation.selections, investigation.cards);
	});
	const viewEvents = $derived.by(() => {
		const session = investigation.result;
		if (session === null) return [];
		return filteredEvents(session.admitted, investigation.selections);
	});
	const cohort = $derived(viewCards.length === 0 ? '' : cohortLine(viewCards, viewEvents));
	const fetched = $derived(investigation.slices.reduce((sum, s) => sum + s.received, 0));
	const truncated = $derived(investigation.notices.some((n) => n.kind === 'truncated'));
	const invalidNote = $derived(
		investigation.notices.find((n) => n.kind === 'invalid-skipped')?.message ?? ''
	);
	// §4 edge states: done with zero surfaced cards — either nothing matched
	// at all (relays confirmed searchable → honest "nothing matched") or the
	// facet selection narrowed everything away (filtered chip variant).
	const emptyDone = $derived(
		investigation.result !== null && investigation.error === null && viewCards.length === 0
	);
	const anyRelayOk = $derived(
		investigation.slices.some((s) => s.status === 'ok') || investigation.result !== null
	);
	// spec §4: all relays dead → error screen, never "no matches". Two shapes:
	// the run settled with an error before any relay answered (transport
	// throw), or every relay leg settled refused/timed out with zero events —
	// the latter reports the per-leg statuses instead of a false EmptyState.
	const allRefused = $derived(
		investigation.slices.length > 0 &&
			!investigation.slices.some((s) => s.status === 'ok' && s.received > 0)
	);
	const relayDead = $derived(
		(investigation.error !== null && !anyRelayOk) ||
			(investigation.phase === 'done' && allRefused && investigation.skeletons.length === 0)
	);
	// The fill ran but nothing interpreted (AI down/timeout on every chunk) —
	// the honest banner beside silently-dashed cards (spec §2 rule 5 + §4).
	const aiDown = $derived(
		investigation.result !== null &&
			!investigation.filling &&
			investigation.fillStats.total > 0 &&
			investigation.fillStats.interpreted === 0
	);
	let dismissed = $state<Set<string>>(new Set());
</script>

<svelte:window onkeydown={handleShellKeydown} />

<Tooltip.Provider delayDuration={350}>
	<!-- inert while settings is open: keyboard focus stays inside the modal. -->
	<div class="flex h-dvh w-full gap-3 p-3" inert={shell.settingsOpen ? true : undefined}>
		<SidebarRecents
			collapsed={!shell.railOpen}
			sessions={shell.sessions}
			activeId={shell.session?.id ?? null}
			onToggle={() => shell.toggleRail()}
			onHome={() => shell.home()}
			onPick={(id) => shell.openSession(id)}
			onClose={(id) => {
			// spec §8: closing the active session aborts its run — the
			// orphan result must not land with no row to display it in.
			if (id === shell.session?.id) investigation.stop();
			shell.closeSession(id);
		}}
			onSettings={() => shell.toggleSettings()}
		/>

		<div
			bind:clientHeight={centerHeight}
			class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window bg-surface shadow-card"
		>
			<div class="flex min-h-0 flex-1 flex-col p-6">
				{#if shell.view === 'search'}
					<!-- J1 hero (issue #37) — the trace (#36) and results (#38)
					surfaces take over the center stage after submit. -->
					<div class="h-full w-full overflow-y-auto p-1">
						<SearchHero
							hasKey={settings.apiKey !== ''}
							onSearch={(q) => void investigation.start(q)}
							onSettings={() => shell.toggleSettings()}
						/>
					</div>
					{:else if shell.view === 'results'}
					<!-- The results surface (#38): trace (36) on top, then facet
						rail + cohort + cards; §4 edge states replace the body. -->
					{#key shell.session?.id}
						{#if relayDead}
							<!-- spec §4: all relays dead — error screen, never demo data -->
							<div class="flex min-h-0 w-full flex-1 flex-col items-center justify-center p-4">
								<ResultsError
									message={investigation.error ?? 'no relay answered the fetch'}
									relays={investigation.slices.map((s) => ({
										url: s.url === 'local-cache' ? 'local cache' : s.url,
										status: s.status
									}))}
									onRetry={() => void investigation.start(investigation.lastQuestion)}
									onEditRelays={() => shell.toggleSettings()}
								/>
							</div>
						{:else}
							<div class="flex min-h-0 w-full flex-1">
								{#if investigation.facetGroups.length > 0}
									<!-- facet rail: deterministic counts (spec §3, never AI) -->
									<div class="w-[216px] shrink-0 overflow-hidden border-r border-line">
										<FacetRail
											groups={investigation.facetGroups}
											selections={investigation.selections}
											onToggle={(p, v) => investigation.toggleFacet(p, v)}
											onClearGroup={(p) => investigation.clearFacet(p)}
											onClearAll={() => investigation.clearFacets()}
										/>
									</div>
								{/if}
								<div class="flex min-h-0 min-w-0 flex-1 flex-col">
									{#if invalidNote !== '' && !dismissed.has(invalidNote)}
										<div class="px-4 pt-1">
											<NoticeBanner
												message={invalidNote}
												onDismiss={() => (dismissed = new Set([...dismissed, invalidNote]))}
											/>
										</div>
									{/if}
									{#each investigation.notices.filter((n) => n.kind === 'capability' && !dismissed.has(n.message)) as notice (notice.message)}
										<div class="px-4 pt-1">
											<NoticeBanner
												message={notice.message}
												onDismiss={() => (dismissed = new Set([...dismissed, notice.message]))}
											/>
										</div>
									{/each}
									{#if aiDown && !dismissed.has('ai-down')}
										<div class="px-4 pt-1">
											<NoticeBanner
												message="AI unreachable — cards show the raw events"
												onDismiss={() => (dismissed = new Set([...dismissed, 'ai-down']))}
											/>
										</div>
									{/if}
									{#if investigation.result !== null}
										<!-- header: cohort line + fetched N (spec §3) -->
										<div class="flex items-baseline gap-3 px-4 pb-1 pt-2">
											<span class="font-sans text-[13px] font-semibold text-ink">{cohort}</span>
											<span class="flex-1"></span>
											<span class="font-mono text-[10.5px] text-ink-3">
												fetched {fetched}{#if truncated} · (relays may hold more){/if}
											</span>
										</div>
									{/if}
									<!-- min-h-0/flex-1 + shrink-0 children: the scroller must own
										scrolling itself; h-full self-sized children clip the top.
										p-1: shadow-card's 1px ring is painted OUTSIDE the border
										box — flush children lose that ring to the overflow clip
										(owner report, issue #36). -->
									<div class="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto p-1 pb-3">
										<div class="w-full max-w-[760px] shrink-0">
											<TaskTrace />
										</div>
										{#if emptyDone}
											<!-- spec §4: relays confirmed searchable, zero matched -->
											<ResultsEmpty
												filtered={Object.keys(investigation.selections).length > 0}
												relayCount={settings.relays.length}
												onClearFilters={() => investigation.clearFacets()}
												onAskDifferently={() => shell.home()}
											/>
										{:else}
											{#each investigation.result !== null ? viewCards : investigation.skeletons as card (card.id)}
												<div class="w-full max-w-[760px] shrink-0">
													<ResultCard {card} />
												</div>
											{/each}
										{/if}
									</div>
								</div>
							</div>
						{/if}
					{/key}
				{:else}
					<p class="m-auto max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
						<span class="font-medium text-ink-2">{shell.session?.title}</span><br />
						The graph canvas lands here with the product-graph step (spec §11 step 3); the
						dossier lives in the drawer below.
					</p>
				{/if}
			</div>

			{#if shell.view === 'session'}
				<DetailDrawer
					open={shell.drawerOpen}
					height={Math.min(shell.drawerHeight, drawerMax)}
					maxHeight={drawerMax}
					onToggle={() => shell.toggleDrawer()}
					onResize={(next) => (shell.drawerHeight = next)}
				/>
			{/if}
		</div>

		{#if shell.view === 'session'}
			<ChatColumn collapsed={!shell.chatOpen} onToggle={() => shell.toggleChat()} />
		{/if}
	</div>

	{#if shell.settingsOpen}
		<SettingsDialog onClose={() => shell.toggleSettings()} />
	{/if}
</Tooltip.Provider>
