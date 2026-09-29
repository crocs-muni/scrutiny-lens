<script lang="ts">
	/* APP SHELL (issue #10, spec §9): three retractable columns —
	 * frameless sessions rail · center canvas swapping search → results →
	 * session (results arrives with the query pipeline, spec §11 step 2)
	 * with the DetailDrawer below the canvas · chat column resident only
	 * while a session is open. */

	import { Tooltip } from 'bits-ui';
	import { handleShellKeydown, shell } from '$lib/shell.svelte';
	import { fillNote, investigation } from '$lib/investigation.svelte';
	import { deriveDossier } from '$lib/dossier';
	import { settings } from '$lib/settings.svelte';
	import SearchHero from '$lib/components/ui/SearchHero.svelte';
	import TaskTrace from '$lib/components/ui/TaskTrace.svelte';
	import ResultCard from '$lib/components/ui/ResultCard.svelte';
	import FacetRail from '$lib/components/ui/FacetRail.svelte';
	import NoticeBanner from '$lib/components/ui/NoticeBanner.svelte';
	import ResultsEmpty from '$lib/components/ui/ResultsEmpty.svelte';
	import ResultsError from '$lib/components/ui/ResultsError.svelte';
	import { applyFacets, cohortLine } from '$lib/pipeline/cards';
	import type { PipelineNotice } from '$lib/pipeline';
	import {
		afterSemantics,
		iTagSelections,
		semanticGroups,
		visibleCards
	} from '$lib/results';
	import SidebarRecents from '$lib/components/ui/SidebarRecents.svelte';
	import DetailDrawer from '$lib/components/shell/DetailDrawer.svelte';
	import GraphCanvas from '$lib/components/graph/GraphCanvas.svelte';
	import ChatColumn from '$lib/components/shell/ChatColumn.svelte';
	import SettingsDialog from '$lib/components/shell/SettingsDialog.svelte';
	import { chat } from '$lib/chat.svelte';
	import type { ProviderOverrideInput } from '$lib/ai/provider';
	import { bestIdentifier } from '$lib/ai/projector';
	import { subjectGrounding, type NostrEvent } from '$lib/fabric';

	let centerHeight = $state(0);

	// The drawer may grow until the canvas keeps a usable strip.
	const drawerMax = $derived(Math.max(240, centerHeight - 120));

	// — Results surface derivations (#38) —
	// i-tag filter first, then the semantic axes (type/status/interpretation,
	// BIBLE J2): the same OR-within/AND-across rule applies both (spec §3).
	const semanticFiltered = $derived.by(() => {
		const session = investigation.result;
		if (session === null) return { events: [], cards: [] };
		const tagSel = iTagSelections(investigation.selections);
		const taggedEvents = applyFacets(session.admitted, tagSel);
		const taggedCards = visibleCards(session.admitted, tagSel, investigation.cards);
		return afterSemantics(taggedEvents, taggedCards, investigation.selections);
	});
	const viewCards = $derived(semanticFiltered.cards);
	const viewEvents = $derived(semanticFiltered.events);
	// Cards render while the fill lands (issue #59): the per-chunk paint
	// needs the product surface live DURING fillInChunks, and a mid-fill
	// card's sweep (driven by investigation.pending, issue #82) has no
	// meaning on the skeleton surface this gate used to keep up. Card-gap
	// (issue #118): the run's presence is the OBSERVER's gate — the card
	// list itself keys on railLive below, because real cards may mount only
	// at the post-context merge (an orphan-metadata-only search assembles
	// zero PRE-context cards, so skeleton-keyed blocks MORPH into card
	// blocks without remounting — their data-card-id appears with no fresh
	// IntersectionObserver notification; the observer effect tracks that
	// flip and re-sweeps, or those visible cards would never arm until a
	// scroll reunion).
	const runLive = $derived(investigation.result !== null);
	const railLive = $derived(runLive && viewCards.length > 0);

	// — Lazy fill (issue #106): the DOM half of the next-N prefetch —
	// The results surface owns the elements; the store owns the policy
	// (armChunk → the claim gate in fillInChunks). While a RUN is live on
	// this surface, an IntersectionObserver rooted on the results scroller
	// arms each card's chunk ~2 screenfuls BEFORE the card scrolls into
	// view (rootMargin '200% 0px' — vertical only, and symmetric because
	// scroll-BACK into a never-armed region must fill just as instantly as
	// scroll-forward; arming is sticky in the store, so the extra direction
	// costs nothing steady-state).
	// Gating on the RUN, never on `filling` (cycle model, owner blocker
	// 2026-09-28): a fill cycle EXITS when nothing armed-with-work remains
	// (filling goes false) and a new arm starts the next cycle — an
	// observer torn down with the cycle could never fire that arm. The
	// observer lives as long as the surface holds the run's cards; an arm
	// with no claimable work is a no-op in the store, so a settled run's
	// scroll events cost nothing.
	let resultsScroller = $state<HTMLDivElement | null>(null);
	let cardObserver: IntersectionObserver | null = null;
	$effect(() => {
		// runLive tracks the run's presence, railLive the skeleton→card
		// MORPH flip (issue #118 — re-sweep arms the morphed wrappers);
		// void keeps the $state reads tracked without branching on either.
		void runLive;
		void railLive;
		if (investigation.result === null || resultsScroller === null) return;
		// Ancient browser without IntersectionObserver: degrade to the
		// pre-#106 eager fill by arming the whole cohort — never starve
		// cards silently.
		if (typeof IntersectionObserver === 'undefined') {
			for (const el of resultsScroller.querySelectorAll('[data-card-id]')) {
				const id = el.getAttribute('data-card-id');
				if (id !== null) investigation.armChunk(id);
			}
			return;
		}
		const scroller = resultsScroller;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const id = entry.target.getAttribute('data-card-id');
					if (id !== null) investigation.armChunk(id);
					// Arming is sticky — once armed, watching buys nothing.
					observer.unobserve(entry.target);
				}
			},
			{ root: scroller, rootMargin: '200% 0px' }
		);
		cardObserver = observer;
		// Wrappers can mount before this effect runs (the fill starts in the
		// same flush the cards paint) — sweep what's already mounted; later
		// mounts and re-registers arrive through use:observeCard below.
		for (const el of scroller.querySelectorAll('[data-card-id]')) observer.observe(el);
		return () => {
			observer.disconnect();
			if (cardObserver === observer) cardObserver = null;
		};
	});
	// Ref action (same convention as GraphCanvas's registerWrapper): card
	// wrappers register with the live observer across keyed-each rebuilds
	// and facet-driven list swaps. A no-op while no fill owns an observer —
	// the effect's sweep above observes already-mounted wrappers when a
	// fill starts.
	function observeCard(el: HTMLElement) {
		cardObserver?.observe(el);
		return {
			destroy() {
				cardObserver?.unobserve(el);
			}
		};
	}
	const railGroups = $derived.by(() => {
		if (investigation.result === null) return investigation.facetGroups;
		return [
			...semanticGroups(investigation.result.admitted, investigation.cards),
			...investigation.facetGroups
		];
	});
	const cohort = $derived(viewCards.length === 0 ? '' : cohortLine(viewCards, viewEvents));

	// — Dossier derivations (#29a) —
	// Store-level selection (ADR 0001): the dossier resolves against the
	// full admitted set, so facet filtering can never make evidence vanish.
	const dossier = $derived.by(() => {
		const id = investigation.selectedEventId;
		const session = investigation.result;
		if (id === null || session === null) return null;
		return deriveDossier(id, session.admitted, investigation.cards);
	});
	// ADR 0001's companion announcement: persistence is never silent. The
	// flag compares against the surface the subject actually renders on:
	// product subjects are visible iff their CARD survives the filters
	// (the interpretation/semantic axes touch cards, not events — an
	// events-only comparison would suppress the announcement exactly when
	// it matters), metadata subjects iff their event survives.
	const selectionHidden = $derived.by(() => {
		if (dossier === null || investigation.selectedEventId === null) return false;
		if (Object.keys(investigation.selections).length === 0) return false;
		const id = investigation.selectedEventId;
		const isCardSubject = investigation.cards.some((c) => c.id === id);
		return isCardSubject
			? !viewCards.some((c) => c.id === id)
			: !viewEvents.some((e) => e.id === id);
	});

	// Session-surface honesty gate (#29b): the canvas AND the drawer derive
	// from the LIVE investigation store. Reopening an older session while a
	// run lives in memory must not paint that other run's evidence under
	// this session's title — the same identity rule the chat's grounding
	// gate holds (ADR 0002); older sessions replay in a future slice.
	const sessionOwnsRun = $derived(
		investigation.sessionId === shell.session?.id && investigation.result !== null
	);

	// — Chat lifecycle (issue #30) —
	// Session-following hydration; both directions route through the store so
	// an in-flight stream is guaranteed aborted (spec §8 "abort on
	// navigation away"): a session switch aborts inside hydrate(), closing
	// the session (or going home) aborts inside reset().
	$effect(() => {
		const id = shell.session?.id;
		if (id !== undefined) void chat.hydrate(id);
		else chat.reset();
	});
	// The unread dot clears when the column is actually visible.
	$effect(() => {
		if (shell.chatOpen) chat.unseen = false;
	});
	// #84's late-key refill is deliberately NOT an $effect: a condition that
	// spends user tokens is caused, not derived. Two explicit call sites own
	// it — restore()'s post-commit tail, and the SettingsDialog close below.
	// (Review H1: an ambient effect on this condition loops failed fills
	// forever — fill ends → filling flips → condition re-fires → re-fill.)
	// Asking needs THE OPEN SESSION's admitted set in memory (ADR 0002
	// grounding set) — sessionIdentity matters: an old session reopened while
	// a different run is live must never cite that run's events.
	const chatGrounded = $derived(
		investigation.sessionId === shell.session?.id &&
			(investigation.result?.admitted.length ?? 0) > 0
	);
	/** BYOK (spec §6): memory-only key, passed straight through. */
	const chatProvider = $derived.by((): ProviderOverrideInput | undefined =>
		settings.apiKey === ''
			? undefined
			: {
					baseUrl: settings.endpoint,
					model: settings.model,
					apiKey: settings.apiKey
				}
	);
	function askChat(question: string): void {
		// Same identity gate as chatGrounded — the composer disables first,
		// but the send closure must not trust the UI.
		const admitted =
			investigation.sessionId === shell.session?.id ? (investigation.result?.admitted ?? []) : [];
		// Grounding scope (user ruling 2026-09-17): with a card open the chat
		// answers about THAT card's cohort — the node, its one-hop neighbors,
		// their bindings and history legs. Without a selection the session's
		// full admitted set stays the grounding (ADR 0002).
		const selected = investigation.selectedEventId;
		const events = selected === null ? admitted : subjectGrounding(admitted, selected);
		const selectedEvent =
			selected === null ? undefined : admitted.find((e) => e.id === selected);
		const rootSummary =
			selectedEvent === undefined
				? (shell.session?.title ?? '')
				: (bestIdentifier(selectedEvent) ?? shell.session?.title ?? '');
		void chat.send(question, {
			events,
			rootSummary,
			provider: chatProvider
		});
	}

	/** Card click / graph node / Files-row deep-link (BIBLE 678): select,
	 * open, land on session. The FIRST subject also anchors the graph
	 * subject (#29b ruling 4, inside selectSubject); clicking the selected
	 * card again re-affirms (#29a ruling 10). */
	function openDossier(id: string): void {
		investigation.selectSubject(id);
		shell.drawerOpen = true;
		shell.view = 'session';
		// §8.2 dossier context (#68/#75): patches and deletions are unreachable
		// by the search's discovery filters, so the dossier fetches them on open.
		void investigation.ensureSubjectContext(id);
	}
	/** Canvas-only deselect (#29b ruling 7): empty-pane click / Esc. */
	function clearSelection(): void {
		investigation.clearSelection();
	}
	/** Esc deselect runs before the shell's Ctrl-map (ruling 7); the settings
	 * modal's own dismissal is untouched (guarded). */
	function onShellKeydown(event: KeyboardEvent): void {
		if (
			event.key === 'Escape' &&
			shell.view === 'session' &&
			!shell.settingsOpen &&
			investigation.selectedEventId !== null
		) {
			clearSelection();
			return;
		}
		handleShellKeydown(event);
	}
	const fetched = $derived(investigation.slices.reduce((sum, s) => sum + s.received, 0));
	const truncated = $derived(investigation.notices.some((n) => n.kind === 'truncated'));
	// Owner ruling 2026-09-09: the 'N invalid skipped' ledger is removed from
	// the results surface (§4 line to follow via the docs ritual); the
	// pipeline still emits the notice — it surfaces only inside the trace's
	// literal layer.
	// §4 edge states: done with zero surfaced cards — either nothing matched
	// at all (relays confirmed searchable → honest "nothing matched") or the
	// facet selection narrowed everything away (filtered chip variant).
	const emptyDone = $derived(
		investigation.result !== null &&
			investigation.error === null &&
			investigation.searches.length > 0 &&
			// The settle traversal (refreshSessionContext) runs while `running`
			// and can turn 0 cards into N: 'Nothing matched' must wait for the
			// honest end of the run, not paint mid-settle (#82 acceptance:
			// zero-results is a SETTLED fact, never an in-flight guess;
			// measured live — ROCA chip flashed the empty pane between
			// result-set and the 58-context arrival).
			investigation.running === false &&
			// A RESTORED session with evicted products is data loss, not a
			// zero-result search (spec §4 conflation): 'Nothing matched' would
			// lie about a partial frontier — the evicted footer line says it.
			(investigation.restoredEvicted === null || investigation.restoredEvicted === 0) &&
			viewCards.length === 0
	);
	const anyRelayOk = $derived(
		investigation.slices.some((s) => s.status === 'ok') || investigation.result !== null
	);
	// spec §4: all relays dead → error screen, never "no matches". Two shapes:
	// the run settled with an error before any relay answered (transport
	// throw), or every relay leg settled refused/timed out with zero events —
	// the latter reports the per-leg statuses instead of a false EmptyState.
	const allRefused = $derived(
		investigation.slices.length > 0 && !investigation.slices.some((s) => s.status === 'ok')
	);
	const relayDead = $derived(
		(investigation.error !== null && !anyRelayOk) ||
			(investigation.phase === 'done' && allRefused && investigation.skeletons.length === 0)
	);
	// The fill settled with REAL failures — spec §4: fallback + dismissible
	// banner, full OR partial degradation. Message stays numeric — never
	// "broken" — and the zero-interpreted text is keyed on the real fill
	// kind: an endpoint that answered but didn't conform is not
	// "unreachable" (spec §2 never-lie).
	// #106 lazy fill: `interpreted < total` ALONE is no longer a failure —
	// beyond-window cards were never asked, so the honest steady state of
	// an unscrolled result must NOT read as a fill failure. The banner fires
	// only when a lane actually lost something: amber ids (asked and
	// lost) or a pinned fill kind (an AIResult failure escaped the
	// retries). Never-asked raw cards show the neutral dashed face and no
	// banner (spec §2).
	const aiNote = $derived(
		investigation.result !== null &&
			!investigation.filling &&
			investigation.fillStats.total > 0 &&
			investigation.fillStats.interpreted < investigation.fillStats.total &&
			(investigation.failed.size > 0 || investigation.fillFailure !== null)
			? fillNote(
					investigation.fillStats.interpreted,
					investigation.fillStats.total,
					investigation.fillFailure,
					investigation.fillErrorMessage,
					investigation.rateLimitedCount
				)
			: ''
	);
	// §4 translate-fallback is surfaced by the pipeline's capability notice
	// (which carries the failure class — timeout/unreachable/etc.) as the
	// banner; no second duplicate here.
	// §4: some relays dead → results from the rest + corner notice (a refused
	// leg is a degradation, not 'no matches'). Rolled up per class — per-leg
	// verbatim statuses live in the trace and footer; wallpapering 4 relays
	// as 4 banners teaches users to ignore the honest lane (review finding).
	const degradedLegs = $derived(
		investigation.slices.filter((s) => s.status !== 'ok')
	);
	const degradedNote = $derived(
		degradedLegs.length === 0
			? ''
			: degradedLegs.length === 1
				? `relay ${degradedLegs[0].url} ${degradedLegs[0].status} — showing results from the rest`
				: `${degradedLegs.length} relays degraded (${degradedLegs.map((l) => l.status).join(' · ')}) — showing results from the rest`
	);
	// #83 (spec §2 never-lie): a restored session must read as fetched from
	// local storage, never as a fresh network replay; evicted ids got no
	// bytes at all and are counted honestly.
	const footerNotes = $derived(
		[
			...(investigation.restoredEvicted === null
				? []
				: investigation.restoredEvicted === 0
					? ['restored from local storage']
					: [
							'restored from local storage',
							`${investigation.restoredEvicted} evicted from local storage`
						]),
			...degradedLegs.map((l) => `relay ${l.url} ${l.status}`)
		]
	);
	// §4 honesty lane: every notice class surfaces as ONE roll-up banner —
	// verbatim per-notice facts live in the trace's ticks. Must be invoked
	// from a $derived so the $state read stays tracked.
	function noticeRollup(kind: PipelineNotice['kind'], plural: string): string {
		const items = investigation.notices.filter((n) => n.kind === kind);
		if (items.length === 0) return '';
		if (items.length === 1) return items[0].message;
		return `${items.length} ${plural} — details in the trace`;
	}
	const capabilityNote = $derived(
		noticeRollup('capability', 'relays report no or unverifiable search support')
	);
	const traversalNote = $derived(noticeRollup('traversal', 'context-fetch warnings'));
	// Issue #31 (spec §4): a cold-open share link carried relay hints and
	// some of them failed — the record still opened (from the rest of the
	// hints or the cache), so it's a degradation banner on both center
	// surfaces, not a block. Gated on hasShareHints (F2): a HINTLESS link
	// that resolved via the configured pool must not be blamed for "failed
	// hints" it never carried (spec §2 never-lie).
	const shareNote = $derived(
		!investigation.hasShareHints || investigation.shareHints.length === 0
			? ''
			: investigation.shareHints.length === 1
				? `hinted relay ${investigation.shareHints[0]} failed — record opened from the rest`
				: `${investigation.shareHints.length} hinted relays failed (${investigation.shareHints.join(' · ')}) — record opened from the rest`
	);
	// §4: no AI key set — everything still works; the hint belongs on the
	// RESULTS surface too (the hero's NoKeyBanner is invisible post-submit).
	const noKey = $derived(settings.apiKey === '' && investigation.result !== null);
	let dismissed = $state<Set<string>>(new Set());
	// Dismissals are per-run: a superseding/new investigation brings back the
	// warnings (review finding — page-level state outlived #36-keyed remounts).
	$effect(() => {
		void shell.session?.id;
		dismissed = new Set();
	});
	// Set-identity reassignment: $state tracks the reference (review finding —
	// the lambda was spelled three times).
	const dismiss = (key: string) => (dismissed = new Set([...dismissed, key]));

	/* #108 fill announcements — ONE polite live region on the results
	 * surface (pending cards carry aria-busy, but nothing SPOKE chunk
	 * progress to assistive tech). Chunk granularity = re-fire when
	 * fillStats.interpreted grows while this run's result is shown; the
	 * text changing under aria-live="polite" IS the announcement, no
	 * motion. The final settle says "All Y cards filled" only when the
	 * settle left nothing raw — a settle that left raw cards stays silent
	 * here because the banner already names the failure (announcing both
	 * would double-report one loss). This is a dedicated div, NOT the
	 * svelte-announcer (route changes). */
	let lastFillAnnounced = 0;
	let finalFillAnnounced = false;
	let fillLive = $state('');
	$effect(() => {
		const filled = investigation.fillStats.interpreted;
		const total = investigation.fillStats.total;
		// The counters reset when a fresh fill starts (fillStats only grows
		// within a run) — the marks reset with them.
		if (filled < lastFillAnnounced) {
			lastFillAnnounced = 0;
			finalFillAnnounced = false;
		}
		if (investigation.result === null || total <= 0) return;
		if (investigation.filling) {
			if (filled > lastFillAnnounced) {
				lastFillAnnounced = filled;
				fillLive = `${filled} of ${total} cards filled`;
			}
			return;
		}
		if (filled === total && !finalFillAnnounced) {
			finalFillAnnounced = true;
			lastFillAnnounced = filled;
			fillLive = `All ${total} cards filled`;
		}
	});
</script>

<svelte:window onkeydown={onShellKeydown} />

<Tooltip.Provider delayDuration={350}>
	<!-- inert while settings is open: keyboard focus stays inside the modal. -->
	<div class="flex h-dvh w-full gap-3 p-3" inert={shell.settingsOpen ? true : undefined}>
		<SidebarRecents
			collapsed={!shell.railOpen}
			sessions={shell.sessions}
			activeId={shell.session?.id ?? null}
			onToggle={() => shell.toggleRail()}
			onHome={() => shell.home()}
			onPick={(id) => {
				shell.openSession(id);
				// The current run IS its session's results — reopening it from the rail
				// returns to the results surface instead of stranding on the placeholder.
				if (id === investigation.sessionId && (investigation.running || investigation.result !== null)) {
					shell.view = 'results';
					return;
				}
				// #83: a session evicted from memory by a reload rebuilds from local
				// storage and lands on the same results surface. Restores that decline
				// (no run row / fully evicted frontier) leave the honest placeholder.
				void investigation.restore(id).then((ok) => {
					// Identity guard (review H2): a start()/openShared() since the
					// click already own the rail — a late restore resolve must
					// never yank the view back.
					if (ok && shell.session?.id === id) shell.view = 'results';
				});
			}}
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
			<div class="flex min-h-0 flex-1 flex-col {shell.view === 'results' ? '' : 'p-6'}">
				{#if shell.view === 'search'}
					<!-- J1 hero (issue #37) — the trace (#36) and results (#38)
					surfaces take over the center stage after submit. -->
					<div class="h-full w-full overflow-y-auto p-1">
						<SearchHero
							hasKey={settings.apiKey !== ''}
							onSearch={(q, title) => void investigation.start(q, title)}
							onSettings={() => shell.toggleSettings()}
						/>
					</div>
					{:else if shell.view === 'results'}
					<!-- The results surface (#38): BIBLE J2 anatomy — 44px breadcrumb
						bar spans the whole window; rail + cards below; §4 edge
						states replace the body. -->
					<!-- #108: the fill's one audible surface — visually hidden,
						polite, chunk-granular (logic above). Kept OUTSIDE the
						{#key} remount so announcements stay pure text diffs in a
						persistent region. -->
					<div aria-live="polite" class="sr-only">{fillLive}</div>
					{#key shell.session?.id}
						<!-- BIBLE J2 header bar: full window width, 44px hairline -->
						<div class="flex h-11 shrink-0 items-center border-b border-line px-4">
							<!-- baseline-aligned cluster (owner report, PR #42 polish):
								items-center misaligned the mixed 12.5/13/11px rows; one true
								baseline per item + svg on the same line, group centered by
								the bar. leading-none so the line-box extents match the
								glyph extents. -->
							<div class="flex min-w-0 flex-1 items-baseline gap-2">
								<span class="leading-none text-[12.5px] text-ink-2">Results</span>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="shrink-0 text-ink-2"><path d="M9 6l6 6-6 6"/></svg>
								<span class="min-w-0 truncate leading-none text-[13px] font-semibold text-ink">{shell.session?.title ?? ''}</span>
								<span class="flex-1"></span>
								<span class="shrink-0 font-mono leading-none text-[11px] text-ink-2">
									fetched {fetched}{truncated ? ' · relays may hold more' : ''}
								</span>
							</div>
						</div>
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
								{#if railGroups.length > 0}
									<!-- facet rail: deterministic counts (spec §3, never AI);
										always on (owner decision, PR #42 — collapse pill removed) -->
									<div class="flex w-[216px] shrink-0 flex-col overflow-hidden border-r border-line">
										<FacetRail
											groups={railGroups}
											selections={investigation.selections}
											onToggle={(p, v) => investigation.toggleFacet(p, v)}
											onClearGroup={(p) => investigation.clearFacet(p)}
											onClearAll={() => investigation.clearFacets()}
										/>
									</div>
								{/if}
								<!-- the scroller must span the full area so its scrollbar sits
									at the outer edge (owner report 2026-09-11: scroll track
									overlaid the card column's border); banner/cohort lanes
									center themselves on the 760 rail individually -->
								<div class="flex min-h-0 min-w-0 flex-1 flex-col">
									<!-- §4 honesty lane: every banner one dismissal-keyed note; the
										no-key hint stays textual (Ctrl+, works) — these are notices,
										not buttons. Per-class roll-up (review finding): per-leg
										verbatim facts live in trace ticks + footer. -->
									{@render note(capabilityNote !== '', 'capability', capabilityNote)}
									{@render note(noKey, 'no-key', 'no key set — cards stay raw · set one in Settings (Ctrl+,)')}
									{@render note(aiNote !== '', 'ai-note', aiNote)}
									{@render note(degradedNote !== '', 'degraded', degradedNote)}
									{@render note(traversalNote !== '', 'traversal', traversalNote)}
									{@render note(shareNote !== '', 'share-hints', shareNote)}
									{#if investigation.result !== null}
										<!-- header: cohort only (spec §3); centers on the same 760
											rail as cards (scroller spans wider so its scrollbar
											lives at the area edge); breadcrumb owns fetched/truncation -->
										<div class="mx-auto flex w-full max-w-[760px] items-baseline gap-3 px-1 pb-1 pt-2">
											<span class="font-mono text-[12.5px] font-semibold text-ink">{cohort}</span>
											{#if selectionHidden}
												<!-- the filtering surface owns its half of the
													announcement (ruling 11): a filtered-out
													selection is stated where it happened. -->
												<span class="font-mono text-[11px] text-ink-2">
													selected event hidden by filters ·
													<button
														type="button"
														class="text-accent-ink underline underline-offset-2 hover:text-ink"
														onclick={() => investigation.clearFacets()}
													>
														clear
													</button>
												</span>
											{/if}
											<span class="flex-1"></span>
										</div>
									{/if}
									<!-- min-h-0/flex-1 + shrink-0 children: the scroller must own
										scrolling itself; h-full self-sized children clip the top.
										p-1: shadow-card's 1px ring is painted OUTSIDE the border
										box — flush children lose that ring to the overflow clip
										(owner report, issue #36). -->
									<div
										class="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto p-1 pb-3"
										bind:this={resultsScroller}
									>
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
											<!-- Card-gap (issue #118): while the settle traversal runs,
												the pre-context cohort can be EMPTY (an orphan-metadata-only
												text search assembles zero product cards) — keep the
												skeleton rail up instead of unmounting into a blank
												column. emptyDone gates the honest zero-verdict on
												running === false, so an empty list here can only be
												mid-settle. -->
											{#each railLive ? viewCards : investigation.skeletons as card (card.id)}
												<!-- data-card-id is the lazy-fill DOM contract
													(issue #106): the observer sweeps and arms by it.
													Cards only — skeletons carry no fill (no admitted
													subject yet, ruling 6). -->
												<div
													class="w-full max-w-[760px] shrink-0"
													data-card-id={railLive ? card.id : undefined}
													use:observeCard
												>
													<!-- skeletons stay inert (ruling 6 — no admitted
														subject behind them); settled cards open the
														dossier, the selected one wears the ring. -->
													<ResultCard
														{card}
														pending={investigation.pending.has(card.id)}
														failed={investigation.failed.has(card.id)}
														draft={railLive ? (investigation.drafts.get(card.id) ?? null) : null}
														selected={card.id === investigation.selectedEventId}
														onOpen={railLive ? () => openDossier(card.id) : undefined}
													/>
												</div>
											{/each}
										{/if}
									</div>
									{#if footerNotes.length > 0}
										<!-- footer ledger (issue #38 S1): degraded legs +
											invalid-skipped count — breadcrumb bar owns
											fetched/truncation (BIBLE J2). Absent notes =
											absent strip (no empty hairline reserve). -->
										<div class="shrink-0 border-t border-line px-4 py-1.5">
											<span class="font-mono text-[10.5px] text-ink-3">{footerNotes.join(' · ')}</span>
										</div>
									{/if}
								</div>
							</div>
						{/if}
					{/key}
				{:else}
					<!-- Session surface (#29b): the subject-graph canvas + drawer, gated on
						session identity — a foreign live run's evidence never paints
						under this session's title. -->
					{#if sessionOwnsRun}
						<div class="flex min-h-0 w-full flex-1 flex-col">
							<!-- issue #31 (spec §4): the cold open lands on the SESSION
								surface, so the failed-hint degradation lives here too —
								same dismissible lane as the results surface. -->
							{@render note(shareNote !== '', 'share-hints', shareNote)}
							{#key investigation.graphSubjectId}
								<GraphCanvas
									events={investigation.result?.admitted ?? []}
									cards={investigation.cards}
									root={investigation.graphSubjectId}
									selectedEventId={investigation.selectedEventId}
									onSelect={openDossier}
									onDeselect={clearSelection}
								/>
							{/key}
						</div>
					{:else}
						{#if investigation.restoreMissId === shell.session?.id}
							<!-- #83 relic: the session's run record is missing or its whole
								frontier was evicted — only a re-run brings the data back. -->
							<div class="m-auto flex max-w-64 flex-col items-center gap-3 text-center">
								<p class="text-[12.5px] leading-relaxed text-ink-3">
									This session's evidence is gone from local storage. Re-run the search to bring it back.
								</p>
								{#if !shell.session?.title.startsWith('Shared ')}
									<button
										class="rounded-control border border-line px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
										onclick={() => void investigation.start(shell.session?.title ?? '')}
									>
										Re-run this search
									</button>
								{:else}
									<!-- Cold-open share sessions (shareTitle, 'Shared ' prefix) carry
										no question — the title is a noun phrase; re-running it would
										search literal nonsense. -->
									<p class="text-[12.5px] leading-relaxed text-ink-3">
										Reopen it via the shared link instead.
									</p>
								{/if}
							</div>
						{:else}
							<p class="m-auto max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
								This session's evidence isn't in memory — older sessions aren't replayable
								yet. Run a new search to bring it back.
							</p>
						{/if}
					{/if}
				{/if}
			</div>

			{#if shell.view === 'session' && sessionOwnsRun}
				<DetailDrawer
					open={shell.drawerOpen}
					height={Math.min(shell.drawerHeight, drawerMax)}
					maxHeight={drawerMax}
					{dossier}
					hiddenByFilter={selectionHidden}
					onSelect={openDossier}
					onClearFilters={() => investigation.clearFacets()}
					onToggle={() => shell.toggleDrawer()}
					onResize={(next) => (shell.drawerHeight = next)}
				/>
			{/if}
		</div>

		{#if shell.view === 'session'}
			<ChatColumn
				collapsed={!shell.chatOpen}
				onToggle={() => shell.toggleChat()}
				unread={chat.unseen}
				grounded={chatGrounded}
				onSend={askChat}
				onOpenDossier={openDossier}
			/>
		{/if}
	</div>

	{#if shell.settingsOpen}
		<SettingsDialog
			onClose={() => {
				shell.toggleSettings();
				// #84: key edits COMMIT at dialog close (the field writes per
				// keystroke — firing there would spend a doomed fill on a partial
				// key). Guards inside keyArrived own every non-fill case.
				void investigation.keyArrived();
			}}
		/>
	{/if}
</Tooltip.Provider>

{#snippet note(show: boolean, key: string, message: string)}
	{#if show && !dismissed.has(key)}
		<!-- §4 honesty lane — centers on the card rail; the scroller stays
			edge-to-edge so its scrollbar lives at the area edge -->
		<div class="mx-auto w-full max-w-[760px] px-1 pt-1">
			<NoticeBanner {message} onDismiss={() => dismiss(key)} />
		</div>
	{/if}
{/snippet}
