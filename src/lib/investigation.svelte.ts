// Investigation orchestrator (issue #37, spec §3/§11 step 2): the J1
// composer's submit lands here — a session is created and runSearch starts.
// The PipelineEvent stream accumulates in runes state; the trace surface
// (#36) and results surface (#38) render from this module, which is why the
// states are typed at the pipeline's own vocabulary instead of a UI shape.
//
// Lifecycle honesty (code-review, spec §8 "abort on navigation away"):
// a new submit aborts the previous run, closing the active session aborts
// too (wired in +page.svelte's onClose), and every run's transport is
// closed when it settles so relay websockets can't accumulate. Events and
// the final state are applied only while the run is still current — an
// aborted run's late slices must not mix into a newer run's arrays.
//
// BYOK: the provider override passes the memory-only key straight through —
// it is never persisted (spec §6).

import { defaultCallLLM, type AIKind, type CallLLM } from "$lib/ai/output";
import { streamLLM, surfaced429Count } from "$lib/ai/gateway";
import type { StreamLLM } from "$lib/ai/records";
import type { ProviderOverrideInput } from "$lib/ai/provider";
import { createTransport, type Transport } from "$lib/net/transport";
import {
  runSearch,
  skeletonOf,
  type Phase,
  type PipelineEvent,
  type PipelineNotice,
  type SearchSession,
  type SkeletonCard,
} from "$lib/pipeline";
import type { SearchRequest } from "$lib/ai/agents/query";
import type { NostrEvent } from 'nostr-tools/core';
import { batchNodeInterpret } from "$lib/ai/agents/nodes";
import {
  getEvent,
  getInterpretation,
  getSessionRun,
  putSessionRun,
  saveInterpretation,
  type CachedEvent,
} from "$lib/db";
import type { NodeTile } from "$lib/graph/subject-graph";
import {
  admitBatch,
  resolveGraph,
  scrutinyEventType,
  type NostrEvent as FabricEvent,
} from "$lib/fabric";
import { indexEvent } from "$lib/search";
import {
  boundContextIds,
  fetchSessionContext,
  fetchSubjectContext,
  fetchSubjectDeletions,
  traversalNoticeText,
  type SessionContextResult,
} from "$lib/pipeline/traversal";
import {
  assembleCards,
  cachedCardFills,
  computeFacets,
  fillCards,
  type FacetGroup,
  type ProductCard,
} from "$lib/pipeline/cards";
import { settings } from "$lib/settings.svelte";
import { shell } from "$lib/shell.svelte";
import { lensDebug } from "$lib/dev-log";

/** Interval sleep that resolves early on abort — the lane-stagger's pause
 * must not outlive the run that scheduled it (spec §8 abort lifecycle). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = () => {
    clearTimeout(id);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const id = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  return promise;
}

/** Abort classification for the fill lanes (issue #104): a throw escaping
 * fillCards is a STALL only when abort-shaped — the chunk arm's
 * AbortSignal.timeout firing (TimeoutError reason), a direct AbortError,
 * or the gateway's attempt timeout surfacing through records' rethrow
 * (a plain transport failure is an AIResult and never throws). Mirrors the
 * error shapes of records.ts isAbort; the signal-state half of that check
 * is the run-alive test at the catch site. Anything else that somehow
 * escapes is a real failure, not a stall — never re-issued. */
function isAbortShaped(err: unknown): boolean {
  const name = String((err as { name?: string } | null)?.name ?? "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  return String((err as Error | null)?.message ?? "")
    .toLowerCase()
    .includes("abort");
}

class Investigation {
  phase = $state<Phase | "idle">("idle");
  /** Per-relay slice receipts, in arrival order — the trace's literal layer. */
  slices = $state<
    {
      url: string;
      received: number;
      route: string;
      rejected: number;
      status: "ok" | "timeout" | "refused";
    }[]
  >([]);
  /** Translated searches (≤3, spec §3) — arrives right after translate. */
  searches = $state<SearchRequest[]>([]);
  /** Rule-5 skeletons as they arrive (spec §2 rule 5). */
  skeletons = $state<SkeletonCard[]>([]);
  notices = $state<PipelineNotice[]>([]);
  /** Assembled product cards (dedupe by root product, spec §3) — lands with
   * the session; AI interpretation fills onto these in chunks below. */
  cards = $state<ProductCard[]>([]);
  /** Facet groups computed from the admitted events' tags (never AI, §3). */
  facetGroups = $state<FacetGroup[]>([]);
  /** Selected facet values per group (OR within a group, AND across, §3). */
  selections = $state<Record<string, Set<string>>>({});
  /** Write-descriptions progress for the trace's fifth row (§4 partial). */
  filling = $state(false);
  /** Cards claimed by a fill lane but not yet merged (issue #59): the
   * interpretation lane's promised-but-unpaid subset — the badge on their
   * raw cards reads `interpreting…` while they sit here. Never AI-written
   * — id membership only — so rule-5 never lies about which cards a lane
   * has actually fired (spec §2). New Set identity per claim/merge so the
   * badge re-fires; in-place mutation would pin the first snapshot. */
  pending = $state<Set<string>>(new Set());
  /** Cards that were claimed by a fill lane but settled WITHOUT an
   * interpretation this pass (issue #82): the amber-tint state. A settle
   * is only final relative to the pass — a later successful pass drains
   * its ids back out. Deliberate aborts never mark: killed ≠ failed
   * (§8 "abort on navigation away" lifecycle; honesty basis §2).
   * TRANSIENT per run — never persisted, exactly like
   * `pending`: amber must remain a live claim, not a memory, or a
   * yesterday-failed endpoint would wallpaper the rail forever. */
  failed = $state<Set<string>>(new Set());
  /** Streaming draft prose (issue #109, spec §9 drafting voice): card id →
   * the pre-gate record's so-far text, already id-gated and clipped to the
   * gate's limits by fillCards. A DASHED-FACE OVERLAY ONLY: memory-only
   * (db.ts never sees it), never announced (the #108 polite region reads
   * fillStats, which counts SETTLED records only), and silently revoked
   * the moment the record's verdict lands — painted, settled raw, or the
   * pass died (runPass's settle clears its pass's ids). Copy-on-write
   * Map, same reactivity rule as cards/pending above. RUN-scoped: a draft
   * in flight belongs to the running pass, so resetRun clears it and no
   * per-cycle clearing exists (a fillInChunks cycle boundary is not a
   * verdict). */
  drafts = $state<Map<string, { title: string; snippet: string }>>(new Map());
  fillStats = $state<{ interpreted: number; total: number }>({
    interpreted: 0,
    total: 0,
  });
  /** Settle-kind of the fill lane (null = no fill failure recorded): lets the
   * results banner say why cards aren't interpreted — a dead endpoint vs one
   * that answered but whose output didn't conform (spec §2 never-lie). */
  fillFailure = $state<AIKind | null>(null);
  /** Concrete reason for the fill-lane failure (provider-validation issues,
   * error text): clipped at set-time, never the key (ADR-018 lane at
   * provider.ts). The banner appends this so a bare kind can't hide the
   * cause (PR #50's incident: "(unreachable)" told you nothing). */
  fillErrorMessage = $state<string | null>(null);
  /** 429s the gateway SAW during this run's fill (issue #105): a delta off
   * the page-lifetime counter captured at fill-settle, so the banner's
   * "endpoint rate limited N×" never grows across runs and never claims
   * more than the endpoint said (spec §2). */
  rateLimitedCount = $state(0);
  /** Lazy fill (issue #106): card ids the results surface armed as
   * "about to be read" — the observer calls armChunk() ~2 screenfuls
   * ahead of the viewport and the claim gate in fillInChunks reads
   * membership SYNCHRONOUSLY. Deliberately NOT a rune: no paint derives
   * from it, so reactivity would only buy re-renders on scroll. STICKY
   * across a run's cycles (scrolling past never disarms — a lane never
   * un-claims either); resetRun clears it for the next run. When a cycle
   * settles (filling false) a new arm starts a fresh cycle. */
  private armed = new Set<string>();
  /** The run's captured fill context (issue #106): a scroll-armed cycle
   * re-fills with the SAME provider + transport the run started with —
   * never live settings, which could differ mid-run (a cycle with another
   * model would poison the (eventId, model) cache keys). Null outside a
   * run; set by fillInChunks, cleared by resetRun. */
  private fillCtx: {
    provider: ProviderOverrideInput;
    callLLM: CallLLM;
    stream?: StreamLLM;
  } | null = null;
  result = $state<SearchSession | null>(null);
  /** Settled failure (never a deliberate abort); the §4 error surfaces
   * (#38) render from this. */
  error = $state<string | null>(null);
  running = $state(false);

  /** Wall time of the settled run (ms) — the done row's "· 4.2s". */
  elapsedMs = $state<number | null>(null);
  /** The question as asked — the error screen's Retry re-fires it (spec §4). */
  lastQuestion = $state("");
  /** The session row this run painted — re-picking it in the rail returns
   * to the results view (older sessions aren't replayable until #29's
   * session-store work, spec §0). */
  sessionId = $state<string | null>(null);

  /** Reload-restore diagnostics (issue #83): null while a live run painted
   * the surface; restore() sets the count of pinned ids the events cache no
   * longer holds (0 = frontier intact). A reassembly count, never AI data. */
  restoredEvicted = $state<number | null>(null);
  /** Session id restore() declined — no pinned run row, or the whole
   * frontier evicted. The relic placeholder + one-click re-run reads it
   * (+page.svelte, issue #83). */
  restoreMissId = $state<string | null>(null);

  /** Hinted relays a cold-open share link reported as failed (issue #31,
   * spec §4): the event still opened — from the rest of the hints or the
   * cache — so this is a degradation notice, not a block. Set by
   * openShared from the resolver's report; dies with the investigation
   * like the run's other state. */
  shareHints = $state<string[]>([]);

  /** Whether the cold-open link carried any relay hints at all (issue #31
   * F2): the share-hints notice only renders combined with a non-empty
   * shareHints — a hintless link that resolved via the configured pool
   * must not be blamed for "failed hints" it never had (spec §4 never-lie). */
  hasShareHints = $state(false);

  /** The selected dossier subject (issue #29a, ADR 0001): store-level —
   * facet filters and view hops never clear it; it dies exactly where the
   * investigation itself dies (start/stop/reset). Deselect is canvas-only
   * (#29b ruling 7 — see clearSelection). */
  selectedEventId = $state<string | null>(null);

  /** The subject graph's fixed subject (issue #29b ruling 4): the FIRST
   * subject opened this investigation. Later selections move the ring and
   * the dossier, never the layout — a re-anchoring click would destroy the
   * ring's spatial memory. Dies with the investigation like the selection. */
  graphSubjectId = $state<string | null>(null);

  /** Expansion stack (issue #29b ruling 8): related products the user
   * expanded, in order — the toolbar's undo chip pops it LIFO.
   * Admitted-only: entries never imply a fetch. */
  expandedRelated = $state<string[]>([]);

  /** #97: ring-1 records whose bridge bubble was clicked — their related
   * products render (and the orange bridge edges with them). */
  expandedBridges = $state<string[]>([]);
  /** One LIFO across both expansion kinds (#29b/#97 compound undo): the
   * toolbar chip pops whichever expansion was LAST, by kind. */
  expansionLog = $state<('related' | 'bridge')[]>([]);

  /** Subjects whose §8.2 dossier context was fetched (or is in flight) —
   * one traversal per subject per session; dies with the session (start()
   * re-creates it with the rest of the run's state). */
  contextFetched = new Set<string>();

  private controller: AbortController | null = null;

  /** Monotonic restore token: the LAST restore click wins — a superseded
   * restore must not paint over a newer one (same honesty class as the
   * controller-identity guards, spec §8). Monotonic forever, never reset. */
  private restoreToken = 0;

  private applyEvent(controller: AbortController, event: PipelineEvent): void {
    // Only the current run may write — an aborted run's late events die here.
    if (this.controller !== controller) return;
    switch (event.type) {
      case "phase":
        this.phase = event.phase;
        break;
      case "slice":
        this.slices.push({
          url: event.url,
          received: event.received,
          route: event.route,
          rejected: event.rejected,
          status: event.status,
        });
        break;
      case "searches":
        this.searches = event.searches;
        break;
      case "skeleton":
        this.skeletons.push(...event.cards);
        break;
      case "notice":
        this.notices.push(event.notice);
        break;
    }
  }

  /** Fresh-canvas reset for a brand-new run (issue #31): start() and
   * openShared() both supersede whatever a live run painted — identical
   * fields, so one reset keeps the two entry points in lockstep. Callers
   * set their deltas right after (start: the question; openShared: done
   * phase + the cold-open's failed hints). */
  private resetRun(): void {
    this.phase = "idle";
    this.lastQuestion = "";
    this.slices = [];
    this.searches = [];
    this.skeletons = [];
    this.notices = [];
    this.result = null;
    this.error = null;
    this.cards = [];
    this.facetGroups = [];
    this.selections = {};
    this.filling = false;
    this.armed = new Set(); // fresh run — the last cohort's arms mean nothing (#106)
    this.fillCtx = null; // and no scroll cycle may start for it
    this.pending = new Set();
    this.failed = new Set();
    this.drafts = new Map(); // fresh run — the last cohort's drafts died with it (#109)
    this.fillStats = { interpreted: 0, total: 0 };
    this.fillFailure = null;
    this.fillErrorMessage = null;
    this.rateLimitedCount = 0;
    this.elapsedMs = null;
    this.selectedEventId = null;
    this.graphSubjectId = null;
    this.expandedRelated = [];
    this.expandedBridges = [];
    this.expansionLog = [];
    this.contextFetched = new Set();
    this.shareHints = [];
    this.hasShareHints = false;
    this.nodeTiles = new Map();
    this.nodeQueue = [];
    this.nodeQueued = new Set();
    // A live run replaces whatever a restore painted — the diagnostics die
    // with it (fresh runs own neither field, issue #83).
    this.restoredEvicted = null;
    this.restoreMissId = null;
    this.running = true;
  }

  /** The fill lane's desire gate (issue #118 review): the early leg, the
   * top-up leg, and the cold-open share the same triple — a provider (key
   * set at run capture), a model, and cards to interpret. One helper keeps
   * the three sites from drifting; the predicate also narrows `provider`
   * for the fill call that follows each gate. */
  private fillDesired(
    provider: ProviderOverrideInput | undefined,
  ): provider is ProviderOverrideInput {
    return provider !== undefined && settings.model !== "" && this.cards.length > 0;
  }

  /** The trace counter's one write shape (spec §2 rule 6): interpreted
   * count against the live denominator. Every fillStats site funnels
   * through here — the counter must never read "raw" beside interpreted
   * cards (issue #118 review). */
  private syncFillStats(cards: ProductCard[]): void {
    this.fillStats = {
      interpreted: cards.filter((c) => c.interpreted).length,
      total: cards.length,
    };
  }

  /** Pin the settled frontier of the CURRENT session (issue #83): on reload
   * the restore seam rebuilds the surface from this row plus the shared
   * events cache — never a re-query, so a restored session paints exactly
   * what settled (spec §2/§6). Fire-and-forget like the orchestrator's
   * other write-through: a lost pin degrades to the relic placeholder,
   * never to a crash. */
  private persistRunRecord(): void {
    if (this.sessionId === null) return;
    // Orphan guard (review M5): stop() + closeSession on an in-flight run
    // cascades the session row away — a late settle must NOT re-pin a
    // session the rail no longer holds; the relic stays a relic.
    if (!shell.sessions.some((s) => s.id === this.sessionId)) return;
    // $state proxy trap (see start()'s settle): read the session back from
    // the field so the pinned ids are the PROXY's admitted set — the same
    // array the cards/facets derivations saw.
    const settled = this.result;
    if (settled === null) return;
    void putSessionRun({
      sessionId: this.sessionId,
      searches: settled.searches,
      admittedIds: settled.admitted.map((e) => e.id),
      settledAt: Date.now(),
      elapsedMs: this.elapsedMs,
    });
  }

  /** Start a search from the J1 composer. The transport and provider are
   * constructed per run from live settings — edits in Settings take effect
   * on the next question, never mid-run. */
  async start(question: string, title?: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    // New runs supersede in-flight restores identically (review H2): the
    // restore token bumps here too, so a late restore commit can never wipe
    // this run's surfaces or mis-pin its frontier into another row.
    ++this.restoreToken;
    this.resetRun();
    this.lastQuestion = question;
    const startedAt = performance.now();

    // The session row exists before the first slice so the rail shows the
    // investigation even if every relay hangs (spec §4: never demo data,
    // but the question itself is real user input). Canned suggestions
    // (SearchSuggestions) name the session with their human label while
    // the run itself rides the corpus-verified probe words — the probe
    // is what translate/routeSearch see, the label is what you read.
    shell.newSession(title ?? question);
    this.sessionId = shell.session?.id ?? null;
    // issue #36: submit lands on the trace/results stage (spec center
    // swap search → results → session); the graph session is #29's.
    shell.view = "results";

    const provider: ProviderOverrideInput | undefined =
      settings.apiKey === ""
        ? undefined
        : {
            baseUrl: settings.endpoint,
            model: settings.model,
            apiKey: settings.apiKey,
          };
    const callLLM: CallLLM = defaultCallLLM;

    // Construction lives INSIDE the failure net (review, issue #36): an
    // empty relay pool or malformed endpoint throws in createTransport —
    // outside the try it became an unhandled rejection with the trace
    // frozen at 5 pending rows, error and running never settling.
    let transport: Transport | null = null;
    // Declared in the try scope so the catch below can chain its drain —
    // a settle-path throw must not orphan the early fill cycle.
    let earlyFill: Promise<void> | null = null;
    try {
      transport = createTransport({ urls: settings.relays });
      const session = await runSearch({
        question,
        relays: settings.relays,
        provider,
        callLLM,
        transport,
        signal: controller.signal,
        emit: (event) => this.applyEvent(controller, event),
      });
      // The transport never sees the abort signal, so a superseded
      // run RESOLVES instead of throwing — the terminal write takes
      // the same identity guard as the sibling writes (review P1).
      if (this.controller === controller) {
        this.result = session;
        if (lensDebug()) {
          console.debug(`[lens-trace] settle: admitted-before-context=${session.admitted.length}`);
        }
        // Card-by-arrival (issue #118): assemble the PRE-context cohort
        // and mount it NOW, before the settle traversal — the cards'
        // keyed ids are the skeleton rail's ids, so the keyed each keeps
        // its blocks alive instead of tearing the skeletons down into an
        // empty list and remounting when the context cards land. The
        // 2026-09-17 incident (cards frozen at a pre-context assembly
        // that was FINAL — an orphan-metadata-only search showed 'Nothing
        // matched' while the corpus held the answer) cannot recur: the
        // merge after the traversal below re-assembles from the full
        // admitted set and is always the last write, and the empty-rail
        // verdict stays `running === false`-gated (+page.svelte's
        // emptyDone).
        this.cards = assembleCards(
          resolveGraph(session.admitted),
          session.admitted,
        );
        this.facetGroups = computeFacets(session.admitted);
        if (lensDebug()) {
          console.debug(`[lens-trace] settle: cards-pre-context=${this.cards.length}`);
        }
        // The fill lane starts on the pre-context cohort too (issue
        // #118): cards begin interpreting while the traversal still runs.
        // NOT awaited here — the traversal must not queue behind the
        // gateway; the leg joins below, ahead of the top-up leg.
        //
        // `filling` ownership (issue #106 cycle model + review on the
        // first #118 pass): the early leg owns the flag from the kick
        // until it drains, on EVERY path. The no-op catch keeps a
        // fillInChunks rejection unhandled-rejection-free (per-chunk
        // degrade lives inside); the finally chain keeps filling true
        // through a settle-path throw — the catch below must NOT flip it
        // while this cycle still runs, or an armChunk starts a SECOND
        // fillInChunks with fresh claimedRanges (double-claim, re-pay,
        // spec §6). On the happy path the join below is the drain.
        if (this.fillDesired(provider)) {
          this.filling = true;
          earlyFill = this.fillInChunks(
            provider,
            callLLM,
            controller,
            streamLLM,
            true,
          ).catch(() => {
            /* per-chunk degrade lives inside fillInChunks */
          });
        }
        // §8.2 settle traversal (lens #68): a text search can admit
        // ORPHAN metadata whose product roots arrive ONLY via the
        // bindings + second-hop legs (measured live 2026-09-17 on
        // lens-demo: 'fastest ECDSA JavaCard' admitted 28 metadata and
        // zero products) — the FINAL assembly waits for it so the
        // settled cohort is the contextual full set.
        await this.refreshSessionContext();
        if (this.controller !== controller) return;
        // $state proxy trap (settle.test.ts guards the same at the guard
        // layers): this.result = session wrapped the session in a PROXY —
        // admitContext pushes context arrivals into the PROXY's admitted
        // (identity-checked against this.result), while our RAW local kept
        // counting the pre-context array. Measured live: fresh=58 pushed,
        // cards=0 assembled — the skeleton rail vanished at settle into
        // 'Nothing matched'. Read the settled set from the proxy field.
        const settled = this.result;
        if (settled === null) return;
        // Final assembly with merge-over (issue #118): the fill lanes
        // write by claimed POSITION (runPass's indexOf), so the merge
        // keeps every pre-context card's slot stable — live entries that
        // advanced (interpreted, or pending mid-pass) win their slot and
        // keep their paint and drafts; untouched raw cards take the
        // fresh assembly (context arrivals can grow a card's
        // bound-metadata/files counts — the fuller truth); amber cards
        // are neither pending nor interpreted, so they take the fresh
        // raw entry and keep their amber face via the failed set —
        // never re-asked. Context arrivals append in assembly order.
        const fresh = assembleCards(
          resolveGraph(settled.admitted),
          settled.admitted,
        );
        const freshById = new Map<string, ProductCard>(
          fresh.map((card): [string, ProductCard] => [card.id, card]),
        );
        const liveIds = new Set(this.cards.map((card) => card.id));
        const mergedCards = this.cards.map((live) => {
          const candidate = freshById.get(live.id);
          return candidate !== undefined &&
            !live.interpreted &&
            !this.pending.has(live.id)
            ? candidate
            : live;
        });
        for (const card of fresh) {
          if (!liveIds.has(card.id)) mergedCards.push(card);
        }
        this.cards = mergedCards;
        this.facetGroups = computeFacets(settled.admitted);
        // First pin (issue #83): AFTER the merged final assembly, so the
        // pinned frontier carries the context arrivals — a crash mid-fill
        // still leaves a restorable row; the finally block re-pins with
        // the done-row timing.
        this.persistRunRecord();
        if (lensDebug()) {
          console.debug(`[lens-trace] settle: admitted-after-context=${settled.admitted.length} cards=${this.cards.length}`);
        }
        // Join the early leg BEFORE any top-up runs: two live
        // fillInChunks instances hold PER-CALL claimedRanges and would
        // double-claim the same chunks (re-paying the endpoint, spec §6).
        // This flip is one synchronous run into the top-up's own
        // filling = true, so armChunk cannot interleave a cycle in the
        // gap.
        if (earlyFill !== null) {
          await earlyFill;
          if (this.controller !== controller) return;
          this.filling = false;
        }
        // Top-up leg (issue #118): fills what the early leg could not
        // claim — context arrivals appended past its entry horizon, or
        // the whole cohort when the pre-context assembly was empty and
        // no early leg fired. Already-interpreted and amber cards fail
        // hasWork, so a covered cohort costs one claim-scan and exits —
        // fillCards' (eventId, model) cache pass re-pays nothing (§6).
        if (this.fillDesired(provider)) {
          this.filling = true;
          // Prod passes the gateway's streamText lane: the fill paints
          // per-record. Tests injecting only callLLM keep the batch path.
          // Lazy (issue #106): the viewport + prefetch window fills now,
          // the rest when scrolled toward — the results surface arms it.
          await this.fillInChunks(provider, callLLM, controller, streamLLM, true);
          if (this.controller === controller) this.filling = false;
        }
      }
    } catch (err) {
      // Deliberate aborts are not errors; real failures settle into the
      // §4 error surface's input instead of an unhandled rejection.
      if (this.controller === controller && !controller.signal.aborted) {
        this.error = err instanceof Error ? err.message : String(err);
        // The early fill keeps owning `filling` until it drains (issue
        // #106): flipping it here would let an armChunk start a second
        // fillInChunks with fresh claimedRanges while the early cycle
        // still runs (double-claim, re-pay, spec §6). Chain the drain —
        // no run guard inside: a superseded run's armChunk gate
        // (controller identity) already refuses new cycles, and the
        // flag must land false even then.
        if (earlyFill !== null) {
          void earlyFill.finally(() => {
            this.filling = false;
          });
        } else {
          this.filling = false;
        }
      }
    } finally {
      // One pool per run: close its relay websockets when it settles.
      await transport?.close();
      if (this.controller === controller) {
        this.running = false;
        this.elapsedMs = Math.round(performance.now() - startedAt);
        // Second pin (issue #83): the done-row timing rides this upsert.
        this.persistRunRecord();
      }
    }
  }

  /**
   * Cold-open adoption for issue #31 share links (spec §1 L22, §8): the
   * shared root was already fetched and admission-gated by the event route
   * (share-open.ts + fabric's admitEvent); this adopts it as a ONE-SUBJECT
   * run shaped exactly like a settled search — same store-level selection,
   * session row, cards, facet groups, fill lane, and dossier-context legs —
   * so the drawer opens on the FULL card-inspection screen for the shared
   * subject, uninterpreted first with the existing progressive fill.
   * `failedHints` are the hinted relays the resolver could not reach; they
   * surface as a dismissible degradation notice on both center surfaces
   * (spec §4: tell the recipient which hinted relays failed). `hadHints`
   * records whether the link carried relay hints at all — the notice
   * renders ONLY when a hinted link actually had failures, so a hintless
   * link that resolved is never blamed for hints it never had (§4).
   */
  async openShared(root: NostrEvent, failedHints: string[], hadHints: boolean): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    // Same supersession rule as start() (review H2): a cold open also
    // invalidates any in-flight restore's commit.
    ++this.restoreToken;
    // Same fresh-canvas reset as start() — a cold open supersedes any
    // live run — plus its deltas: no trace stages, hints carried over.
    this.resetRun();
    this.phase = "done";
    this.shareHints = failedHints;
    this.hasShareHints = hadHints;

    // The session row exists before any card paints (same rationale as
    // start()): the rail shows the shared investigation while the fill
    // lane works. There is no question — the type tag names it honestly.
    shell.newSession(this.shareTitle(root));
    this.sessionId = shell.session?.id ?? null;
    shell.view = "session";
    shell.drawerOpen = true;

    this.result = {
      searches: [],
      admitted: [root],
      invalidSkipped: 0,
      notices: [],
      relays: [],
    } as SearchSession;
    this.cards = assembleCards(resolveGraph([root]), [root]);
    this.facetGroups = computeFacets([root]);
    // Store-level selection: the drawer opens on the shared subject — the
    // card-inspection screen the share URL promises (spec §8).
    this.selectSubject(root.id);
    // §8.2 dossier context — patches and deletions are unreachable by the
    // search's discovery filters; open them the way a card click would
    // (fire-and-forget like openDossier, spec §8.2 lens #68). Same $state
    // proxy trap as start()'s settle: the context lanes append to the
    // PROXY's admitted — the raw [root] card assembly above is frozen at
    // the pre-context shape forever without a re-read sweep (trap-sweep
    // 2026-09-17). Re-assemble once the settle lands, guarded for a newer
    // open in flight.
    {
      const shared = this.result;
      void this.refreshSessionContext().then(() => {
        if (this.result !== shared || shared === null) return;
        this.cards = assembleCards(
          resolveGraph(shared.admitted),
          shared.admitted,
        );
        this.facetGroups = computeFacets(shared.admitted);
        // Pin (issue #83, review L8): AFTER the context sweep so the row
        // carries the full contextual frontier — a prior-context pin would
        // restore the bare root only. searches stays [] (shared opens have
        // none); shareHints/hasShareHints stay cleared — transient relay
        // state, not session evidence.
        this.persistRunRecord();
      });
    }
    void this.ensureSubjectContext(root.id);
    // Cache write-through: a revisit of the same link (or a search that
    // finds the event) hits getEvent cache-first instead of re-fetching
    // (spec §6). Best-effort like the pipeline's own write-through.
    void indexEvent(root as unknown as FabricEvent).catch(() => {});

    // Progressive fill — the SAME existing lane as a search (spec §8
    // "uninterpreted first"): the shared card renders rule-5 immediately
    // and interprets in chunks when a provider is configured. Cached
    // interpretations return instantly from the cache pass inside.
    const provider: ProviderOverrideInput | undefined =
      settings.apiKey === ""
        ? undefined
        : {
            baseUrl: settings.endpoint,
            model: settings.model,
            apiKey: settings.apiKey,
          };
    if (this.fillDesired(provider)) {
      // Fire-and-forget, deliberately NOT awaited: the cold open's caller
      // (the event route) must hand over to the shell immediately — the
      // card renders rule-5 now and the existing fill lane interprets it in
      // place on the session surface ("uninterpreted first", spec §8).
      this.filling = true;
      // Lazy (issue #106) — a shared root is one card in practice, which
      // is chunk 0: armed at t0, so the cold-open paint is unchanged.
      void this.fillInChunks(provider, defaultCallLLM, controller, streamLLM, true)
        .catch(() => {})
        .finally(() => {
          if (this.controller === controller) this.filling = false;
        });
    }
    if (this.controller === controller) {
      this.running = false;
      this.elapsedMs = 0;
    }
  }

  /** Run title for a shared root — there is no question (spec §8); the
   * core's own type classifier names the card honestly from its `t` tag
   * ("Shared product" / "Shared metadata"), falling back to the neutral
   * "Shared event" for anything else (a foreign or type-less root can
   * never reach here anyway — the gate rejects it, spec §3). Hand-rolled
   * tag sniffing is not used: core is the single classifier (AGENTS.md). */
  private shareTitle(root: NostrEvent): string {
    const type = scrutinyEventType(root as unknown as FabricEvent);
    return type === "product" || type === "metadata" ? `Shared ${type}` : "Shared event";
  }

  /** Reload-restore (issue #83): rebuild a reopened session's settled
   * surface from its pinned run record plus the shared events cache. The
   * paint is deterministic reassembly (graph/cards/facets) and persisted
   * interpretations only — no re-query, no drift (spec §2 never-lie, §6
   * cache). Returns false — and names the session in restoreMissId — when
   * there is no run row or the whole frontier was evicted: the relic
   * placeholder + one-click re-run takes over (+page.svelte). */
  async restore(sessionId: string): Promise<boolean> {
    if (this.sessionId === sessionId) return true; // already painted
    const token = ++this.restoreToken; // races: last click wins
    const run = await getSessionRun(sessionId);
    if (this.restoreToken !== token) return false;
    this.restoreMissId = null;
    if (run === null) {
      this.restoreMissId = sessionId;
      return false;
    }
    // Displacement (owner ruling 2026-09-26): restore always wins the
    // surface. A displaced run's SETTLED frontier pins first; its completed
    // interpretations are already per-event persisted; then it aborts under
    // the spec §8 "abort on navigation away" lifecycle. A mid-flight run
    // (result === null) has no frontier to pin — its events stay in the
    // cache and its row stays a relic.
    if (this.sessionId !== null && this.result !== null) this.persistRunRecord();
    // Rotate BEFORE the cache reads (review H1): applyEvent guards on
    // identity only, not the signal — a superseded runSearch ignoring the
    // abort (see start()'s settle comment) would otherwise resolve during
    // these awaits with `this.controller === controller` intact and
    // overwrite under the restored session.
    this.controller?.abort();
    this.controller = new AbortController();
    const cached = await Promise.all(run.admittedIds.map((id) => getEvent(id)));
    if (this.restoreToken !== token) return false;
    const events = cached.filter((e): e is CachedEvent => e !== null);
    const missing = cached.length - events.length;
    if (events.length === 0) {
      // Fully evicted frontier — the same honest decline as a missing row.
      this.restoreMissId = sessionId;
      return false;
    }
    // Cache paint + assembly happen BEFORE the write block so the state
    // commit below is ONE synchronous unit — the +page late-key effect
    // (which owns all post-settle refills, #84) can only observe a complete
    // snapshot, never a half-painted restore it could double-fill.
    const assembled = assembleCards(resolveGraph(events), events);
    // Keyless cache pass (spec §6): persisted card interpretations are
    // local data — painting them costs no endpoint. Runs even with a key
    // present; the effect's fill then descends only onto real misses.
    const painted =
      settings.model === ""
        ? assembled
        : (await cachedCardFills(assembled, settings.model)).map(
            (p, i) => p ?? assembled[i],
          );
    if (this.restoreToken !== token) return false;
    this.resetRun(); // ends running=true; set deltas below
    this.phase = "done";
    this.sessionId = sessionId;
    this.searches = run.searches;
    // Trace honesty (review H3, spec §2 rule 6): the literal layer reports
    // the cache reconstruction in the pipeline's OWN vocabulary — the
    // rule-5 skeletons a live settle painted, and one cache slice exactly
    // as runSearch emits it. Eviction is NOT rejection, so rejected: 0.
    this.skeletons = events.map((e) => skeletonOf(e));
    this.slices = [
      {
        url: "local-cache",
        received: events.length,
        route: "cache",
        rejected: 0,
        status: "ok",
      },
    ];
    this.result = {
      searches: run.searches,
      admitted: events,
      invalidSkipped: 0,
      notices: [],
      relays: [],
    } as SearchSession;
    this.cards = painted;
    this.facetGroups = computeFacets(events);
    this.elapsedMs = run.elapsedMs;
    this.restoredEvicted = missing;
    if (settings.model !== "") {
      // Seed the trace's descriptions row (review H3d): cache paints ARE
      // rendered interpretations — the decouple counter must never read
      // "raw" beside them (spec §2 rule 6).
      this.syncFillStats(painted);
    }
    this.running = false;
    // #84's other half (ruling: caused, not derived): a key being present
    // at restore is one of the two refill call sites. Fired ONLY from this
    // post-commit tail, so the lane always sees the complete snapshot and
    // its own identity gate is satisfied (shell.session was switched by the
    // rail click before restore was called); fire-and-forget like
    // openShared's lane — the rail never waits on an endpoint.
    void this.keyArrived();
    return true;
  }

  /** Late-key refill (issue #84): a session that settled keyless painted
   * rule-5 raw, and the node trickle's keyless pass drained its queue
   * permanently — entering the key in Settings afterwards never re-armed
   * either lane. keyArrived re-arms both against the CURRENT settled
   * session (restored sessions included, #83): the node queue resets and
   * re-queues the admitted set (cache-first per spec §6, so primed nodes
   * paint without an endpoint), then the same chunked fill lane start()
   * runs fills the raw cards. Awaits the batch + node drain so callers and
   * tests observe a settled lane. No-op without a settled surface, while a
   * fill is in flight, or without key+model — the raw cards stay honest. */
  async keyArrived(): Promise<void> {
    await this._lateKeyRefill(defaultCallLLM, streamLLM);
  }

  /** @internal — test seam for the late-key lane (same shape as
   * `_fillInChunksForTests`): the injected callLLM drives the BATCH path —
   * the production stream seam would route around it to the real gateway. */
  async _keyArrivedForTests(callLLM: CallLLM): Promise<void> {
    await this._lateKeyRefill(callLLM, undefined);
  }

  private async _lateKeyRefill(
    callLLM: CallLLM,
    stream: StreamLLM | undefined,
  ): Promise<void> {
    if (this.result === null || this.filling) return;
    if (settings.apiKey === "" || settings.model === "") return;
    // Session-identity gate (review): a refill may ONLY answer for the open
    // session — a call that still sees the displaced session's painted run
    // (key committed mid-restore) must bail and let the restore's own
    // post-commit refill take over. Wrong-session by-index merges are a
    // spec §2 violation, not a token nit.
    if (this.sessionId !== shell.session?.id) return;
    // Re-arm a possibly-aborted controller (user stopped a run, then set
    // the key).
    if (this.controller === null || this.controller.signal.aborted)
      this.controller = new AbortController();
    const controller = this.controller;
    // Per #84's notes: a keyless pass drains the node queue permanently —
    // re-arm.
    this.nodeQueue = [];
    this.nodeQueued = new Set();
    this.nodeFillFor(this.result.admitted.map((e) => e.id));
    if (this.cards.some((c) => !c.interpreted)) {
      const provider = {
        baseUrl: settings.endpoint,
        model: settings.model,
        apiKey: settings.apiKey,
      };
      this.filling = true;
      try {
        // Stream seam defaults to the production gateway (progressive
        // per-record paint, same as start()/openShared()); tests pass
        // explicit undefined so the injected callLLM drives the batch
        // path. Lazy (issue #106) like the other production fills: the
        // restored cohort's beyond-window chunks arm as the user scrolls
        // the results surface (chunk 0 always fires).
        await this.fillInChunks(provider, callLLM, controller, stream, true);
      } catch {
        /* per-chunk degrade lives inside fillInChunks */
      } finally {
        if (this.controller === controller) this.filling = false;
      }
    }
    // Await the node drain so callers/tests observe a settled lane. Aborts
    // and supersession must exit (runNodeFill leaves its queue on abort).
    while (
      this.controller === controller &&
      !controller.signal.aborted &&
      (this.nodeFillRunning || this.nodeQueue.length > 0)
    ) {
      await sleep(5, controller.signal);
    }
  }

  /** Abort the in-flight run (spec §8) without clearing what it already
   * painted — the abort settles it through the same finally path. */
  stop(): void {
    // Selection survives an abort (ruling 10): stop() freezes the run but
    // keeps what it painted, so the dossier's evidence is still intact.
    this.controller?.abort();
  }

  /** @internal — the singleton's reset seam (same convention as
   * `_closeForTests`): drop arming + fill context so a stale cycle can
   * never start for a reset store (issue #106). */
  resetArming(): void {
    this.armed = new Set();
    this.fillCtx = null;
  }

  /** Arming entry point for lazy fill (issue #106): the results surface's
   * IntersectionObserver calls this as a card approaches the viewport.
   * Sticky and idempotent: re-arming an armed id is a no-op, disarming
   * never happens, and the set survives until the next run resets it.
   *
   * CYCLE MODEL (owner blocker, 2026-09-28): a lazy fill settles when no
   * armed-with-work chunk remains (filling goes false — the §4 banner and
   * keyArrived's guard both read it), and a NEW arm while the run is still
   * alive starts a fresh fill cycle over the armed remainder. Lanes re-scan
   * from scratch each cycle; claimedRanges is per-call, and only
   * still-raw non-amber cards in armed chunks fire requests — the
   * (eventId, model) cache pass inside fillCards swallows everything
   * already filled (spec §6). */
  armChunk(cardId: string): void {
    if (this.armed.has(cardId)) return;
    this.armed.add(cardId);
    // Fresh cycle when no fill is running, mirroring the claim gate
    // exactly: chunk 0 with work still counts (the t0 viewport contract),
    // as does any armed raw non-amber card. The fill context is the RUN's
    // captured provider — a cycle must never re-read live settings and
    // fill with a different (endpoint, model) than the run started with.
    const ctx = this.fillCtx;
    if (ctx === null || this.filling) return;
    if (this.controller === null || this.controller.signal.aborted) return;
    const hasWork = (c: (typeof this.cards)[number]): boolean =>
      !c.interpreted && !this.failed.has(c.id);
    const claimable =
      (this.cards.length > 0 && this.cards.slice(0, 3).some(hasWork)) ||
      this.cards.some((c) => this.armed.has(c.id) && hasWork(c));
    if (claimable) {
      this.filling = true;
      void this.fillInChunks(ctx.provider, ctx.callLLM, this.controller, ctx.stream, true)
        .catch(() => {
          /* per-chunk degrade lives inside fillInChunks */
        })
        .finally(() => {
          if (this.controller !== null) this.filling = false;
        });
    }
  }

  /** Dossier-open from any surface (card row, graph node, citation). The
   * FIRST subject of an investigation also anchors the graph subject (#29b
   * ruling 4); later opens move ring + dossier only. */
  selectSubject(id: string): void {
    this.selectedEventId = id;
    if (this.graphSubjectId === null) this.graphSubjectId = id;
  }

  /** Canvas-only deselect (#29b ruling 7): empty-pane click / Esc clear the
   * ring and return the drawer to its honest no-subject line. The graph
   * subject stays (ruling 4). The results cards' click-to-reaffirm (#29a
   * ruling 10) is untouched — this path never runs there. */
  clearSelection(): void {
    this.selectedEventId = null;
  }

  /** Reveal a related product's admitted neighbors (#29b ruling 8). */
  expandRelated(id: string): void {
    if (this.expandedRelated.includes(id)) return;
    this.expandedRelated.push(id);
    this.expansionLog.push('related');
  }

  /** Reveal the related products behind a ring-1 record (#97: the bridge
   * bubble is the only way, one record at a time). */
  expandBridge(id: string): void {
    if (this.expandedBridges.includes(id)) return;
    this.expandedBridges.push(id);
    this.expansionLog.push('bridge');
  }

  /* ---------------------------------------------------------------- *
   * Node-interpretation trickle (#29c, owner ruling C 2026-09-16)
   *
   * The canvas reports its placed ids whenever the graph re-derives;
   * this lane pays the LLM for everything the CARD fill never touched
   * (linked records, related products). Cache-first: a revisited graph
   * paints sans at t≈0 from bySurface.node. Single-flight, ≤12/batch
   * (the nodes agent's contract), the worklist drains live so a related
   * expansion just appends. Interpretation only ever UPGRADES a node —
   * anything unanswered stays rule-5 mono, which is true at render time
   * (spec §2), so there is no spinner/badge surface by design.
   * ---------------------------------------------------------------- */
  /** Materialized interpretations keyed by event id — the subject-graph
   * reads this map on every derive; whole-map copies per batch (copy-on-
   * write, same reactivity rule as the card merge). */
  nodeTiles = $state<Map<string, NodeTile>>(new Map());
  /** Single-flight guard + the live worklist (queued ids, in priority
   * order — the canvas passes subject→records→related order). */
  private nodeQueue: string[] = [];
  private nodeQueued = new Set<string>();
  private nodeFillRunning = false;

  /** The canvas reports placed ids; the lane starts (once) and drains. */
  nodeFillFor(placedIds: string[]): void {
    if (this.result === null) return;
    let added = false;
    for (const id of placedIds) {
      if (this.nodeTiles.has(id) || this.nodeQueued.has(id)) continue;
      this.nodeQueued.add(id);
      this.nodeQueue.push(id);
      added = true;
    }
    if (added && !this.nodeFillRunning) void this.runNodeFill();
  }

  private async runNodeFill(): Promise<void> {
    const controller = this.controller;
    if (controller == null) return;
    this.nodeFillRunning = true;
    try {
      while (this.nodeQueue.length > 0) {
        // Identity guard with the run-abort: a superseded/stopped run
        // drops the whole tail — dead-run titles never write over a new
        // subject (spec §8 lifecycle).
        if (this.controller !== controller || controller.signal.aborted) return;
        const batch: string[] = [];
        while (batch.length < 12 && this.nodeQueue.length > 0) {
          const id = this.nodeQueue.shift();
          if (id !== undefined && !this.nodeTiles.has(id)) batch.push(id);
        }
        if (batch.length === 0) continue;
        const model = settings.model;
        // Cache pass — zero-cost paints (spec §6). bySurface merge means
        // a node surface never stomps the card surface of the same event.
        for (const id of batch) {
          const hit = await getInterpretation(id, model);
          const surface = hit?.bySurface.node as Partial<NodeTile> | undefined;
          if (typeof surface?.title === "string" && typeof surface.typeToken === "string") {
            const next = new Map(this.nodeTiles);
            next.set(id, {
              title: surface.title,
              typeToken: surface.typeToken,
              metaType: surface.metaType,
              label: surface.label,
            });
            this.nodeTiles = next;
          }
        }
        const missing = batch.filter((id) => !this.nodeTiles.has(id));
        // No provider, no call — the honest fallback stays painted.
        if (missing.length === 0 || settings.apiKey === "" || model === "") continue;
        const admitted = this.result?.admitted;
        if (admitted === undefined) return;
        const events = admitted.filter((e) => missing.includes(e.id));
        if (events.length === 0) continue;
        if (this.controller !== controller) return;
        const res = await batchNodeInterpret({
          events,
          graphContext: { rootSummary: "", query: this.lastQuestion },
          // 60s: the first call against a cold BYOK endpoint is the
          // gateway's slowest — same arm the card lanes use (issue #53).
          abortSignal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60_000),
          ]),
          provider: {
            baseUrl: settings.endpoint,
            model,
            apiKey: settings.apiKey,
          },
          callLLM: defaultCallLLM,
        });
        if (this.controller !== controller) return;
        if (!res.ok) {
          // Unreachable endpoint: stop burning tokens; schema/content
          // failures retry nothing — the fallback is already the truth.
          if (res.kind === "unreachable") {
            // Drain the tail honestly (review M1): ids stay rule-5 until
            // something re-queues them (nodeQueued semantics), but the
            // queue itself empties — keyArrived's drain-wait must never
            // spin on an orphaned queue.
            this.nodeQueue = [];
            return;
          }
          continue;
        }
        const vms = res.result.nodes;
        const interpreted = new Set(res.result.interpretedIds);
        const next = new Map(this.nodeTiles);
        // Saves are awaited with the batch, not void-fired: an orphaned
        // write committing AFTER the lane reported drained would let a
        // staler fallback-era read race a later wipe (data-loss class —
        // reproduced as a test flake where a committed row survived the
        // harness's clearAllLocalData).
        const saves: Promise<void>[] = [];
        for (const vm of vms) {
          if (!interpreted.has(vm.entityId)) continue; // skeleton — never persisted (spec §2)
          const tile: NodeTile = {
            title: vm.title,
            typeToken: vm.typeToken as string,
            ...(vm.kind === "metadata"
              ? { metaType: vm.metaType, label: vm.label }
              : {}),
          };
          next.set(vm.entityId, tile);
          saves.push(saveInterpretation(vm.entityId, model, "node", tile));
        }
        await Promise.all(saves);
        this.nodeTiles = next;
      }
    } finally {
      this.nodeFillRunning = false;
    }
  }


  /** Toolbar's undo chip — pops the LAST expansion, either kind (#29b/#97
   * compound LIFO via expansionLog). */
  undoExpandRelated(): void {
    const last = this.expansionLog.pop();
    if (last === 'bridge') this.expandedBridges.pop();
    else if (last === 'related') this.expandedRelated.pop();
  }

  /** @internal — the module-level reset seam (reload/close) clears the
   * lane's private worklist; public state is cleared directly there. */
  _resetNodeFill(): void {
    this.nodeTiles = new Map();
    this.nodeQueue = [];
    this.nodeQueued = new Set();
  }

  /** @internal — test seam for the node trickle (same spirit as
   * `_fillInChunksForTests`): seeds a settled result, arms a controller,
   * queues ids, awaits full drain. UI callers go through nodeFillFor. */
  async _nodeFillForTests(ids: string[], admitted: FabricEvent[]): Promise<void> {
    this.controller = new AbortController();
    this.result = { admitted } as SearchSession;
    this.nodeFillFor(ids);
    while (this.nodeFillRunning || this.nodeQueue.length > 0) {
      await sleep(5, this.controller.signal);
    }
  }

  /** Traversal-failure visibility (lens #68, spec §4 honesty lane): the
   * notice lands in the existing PipelineNotice surface — one roll-up per
   * message, deduped so the trace's text-keyed ticks never collide. */
  private noticeTraversalOnce(message: string): void {
    if (this.notices.some((n) => n.kind === 'traversal' && n.message === message)) return;
    this.notices.push({ kind: 'traversal', message });
  }

  /** Shared tail of every traversal leg: batch admission against the live
   * session, append + cache write-through, honest failure notices. */
  private async admitContext(
    session: SearchSession,
    fetch: (transport: Transport) => Promise<SessionContextResult>,
  ): Promise<void> {
    let transport: Transport | null = null;
    try {
      transport = createTransport({ urls: settings.relays });
      const result = await fetch(transport);

      // Session identity guard (lifecycle honesty): a late traversal must
      // never mix into a newer run's admitted set.
      if (this.result !== session) return;
      const fresh = admitBatch(
        session.admitted as unknown as FabricEvent[],
        result.events as unknown as FabricEvent[],
      );
      if (lensDebug()) {
        console.debug(`[lens-trace] admitContext: fetched=${result.events.length} candidates→fresh=${fresh.length} rounds=${result.rounds.length} capped=${result.capped}`);
        for (const cand of result.events.slice(0, 10)) {
          const tt = cand.tags.filter((t) => t[0] === 't').map((t) => t[1]).join('/');
          const admitted = fresh.some((f) => f.id === cand.id);
          if (!admitted) console.debug(`[lens-trace]   dropped ${cand.id.slice(0, 10)} t=${tt}`);
        }
      }
      // Session invariant: admitted is unique by event id. admitBatch
      // dedupes candidates against a SNAPSHOT of the batch, and the push
      // loop below is the only writer — but a concurrent context leg
      // (dossier-open re-poll racing the settle pass) writes the same
      // array between snapshot and push. That race surfaced live as an
      // each_key_duplicate on the results rail (product id twice at
      // indexes 27/28, ROCA run 2026-09-17). Guard at the merge point —
      // the invariant's home, cheap.
      const seenIds = new Set(session.admitted.map((e) => e.id));
      for (const event of fresh) {
        if (seenIds.has(event.id)) continue;
        session.admitted.push(event);
        seenIds.add(event.id);
        // Cache write-through is deliberate (#68's repeat-query #28
        // contract): the next search's cache-first read sees this context.
        // Side effect, disclosed: later searches may now admit these
        // patches/deletions/bindings at search time.
        void indexEvent(event).catch(() => {});
      }
      const degraded = traversalNoticeText(result.rounds);
      if (degraded !== undefined) this.noticeTraversalOnce(degraded);
      if (result.capped > 0) {
        this.noticeTraversalOnce(
          `context fetch bounded — bindings for ${result.capped} more events not fetched`,
        );
      }
    } catch (err) {
      // Best-effort context — a traversal failure must not poison the run's
      // painted state, but it IS reported (§4): the dossier reads emptier
      // than the relays may hold.
      if (this.result !== session) return;
      const reason = err instanceof Error ? err.message : String(err);
      this.noticeTraversalOnce(
        `context fetch failed (${reason}) — Files counts and retraction pills may be incomplete`,
      );
    } finally {
      await transport?.close();
    }
  }

  /** §8.2 session-settle pass (lens #68): one batched traversal over the
   * FINAL admitted set once the search lands — bindingsReferencing unioned
   * per product/metadata id (Files rows / metadata deep-links), deletionsFor
   * for every cached event (DQ-2 first sight), one bounded second hop for
   * the bindings' missing endpoints. start() awaits this pass BEFORE
   * assembling cards/facets: a freetext search can land only ORPHAN
   * metadata (no product touching the query words, only its records), and
   * the second hop is the only thing that brings their roots into the
   * session — cards assembled pre-context painted an empty rail over a
   * populated corpus (measured on lens-demo, 2026-09-17). Dossier legs
   * still never re-run the search shapes (§3). */
  async refreshSessionContext(): Promise<void> {
    // Reads this.result (the $state proxy), never a caller's raw session
    // object: admitContext's identity guard compares against the same
    // field, and Svelte 5 proxies on assignment — a raw local would fail
    // the check even for the CURRENT run.
    const session = this.result;
    if (session === null || session.admitted.length === 0) return;
    await this.admitContext(session, (transport) =>
      fetchSessionContext(
        session.admitted as unknown as FabricEvent[],
        settings.relays,
        transport,
      ),
    );
  }

  /** §8.2 dossier-context fetch (lens #68, tools #75): discovery filters can
   * never reach a chain's patches (no i tags, §8.1 step 4) or its deletions
   * (no #t, §3.2), so opening a dossier fires the traversal legs directly.
   * Admission is BATCH-resolved (fabric admitBatch): a per-event admitEvent
   * holds every patch `pending` (UR-2 — no lookup backing), so the whole
   * chain would drop silently. Newly admitted events APPEND to the
   * session's admitted set — the dossier derives from that same array, so
   * History/Retraction rows re-derive in place; facet groups and the graph
   * canvas deliberately do not re-run (§3: those are the search's shape,
   * not one subject's context).
   *
   * DQ-2 periodic re-poll (owner plan on #68, 2026-09-14): the full
   * patches/deletions traversal runs once per subject per session
   * (contextFetched precedent); every LATER dossier open re-issues only the
   * cheap deletion legs for the subject and its bound patches/bindings, so a
   * mid-session retraction still lands as the drawer's retraction pill.
   * Failures surface through the notices lane (admitContext). */
  async ensureSubjectContext(subjectId: string): Promise<void> {
    const session = this.result;
    if (session === null) return;
    if (!session.admitted.some((e) => e.id === subjectId)) return;
    if (this.contextFetched.has(subjectId)) {
      const contextIds = boundContextIds(session.admitted as unknown as FabricEvent[], subjectId);
      await this.admitContext(session, (transport) =>
        fetchSubjectDeletions(subjectId, contextIds, settings.relays, transport),
      );
      return;
    }
    this.contextFetched.add(subjectId);
    await this.admitContext(session, (transport) =>
      fetchSubjectContext(subjectId, settings.relays, transport),
    );
  }

  /** Facet selection (spec §3: OR within a group, AND across groups).
   * Fresh Set/array identities per call so the derived filtered lists re-run. */
  toggleFacet(prefix: string, value: string): void {
    const next: Record<string, Set<string>> = { ...this.selections };
    const values = new Set(next[prefix] ?? []);
    if (values.has(value)) values.delete(value);
    else values.add(value);
    if (values.size === 0) delete next[prefix];
    else next[prefix] = values;
    this.selections = next;
  }

  clearFacet(prefix: string): void {
    const next = { ...this.selections };
    delete next[prefix];
    this.selections = next;
  }

clearFacets(): void {
    this.selections = {};
  }
  /** Chunked interpretation fill (spec §7: cards start rendering
   * interpreted within ~10s — first-paint contract). Small chunks (3
   * cards, ≈600-850 decode-token budget) across 4 striped lanes:
   * output-token decode dominates wall clock (fix was researched against
   * many-small-parallel practice — see PR #42 review-round record), so
   * lanes interleave requests instead of one serial 100-150s walk.
   * Pacing is the gateway's job now (issue #104): no lane stagger, no
   * scheduling here — the gateway's per-baseUrl window shapes what the
   * endpoint sees. Each chunk keeps its own 60s arm (perChunkMs; tests
   * drive it down through the seam) — past the gateway's 429-cooldown
   * horizon (Retry-After capped at 15s, issue #53) so a lane survives
   * one cooldown cycle in-queue instead of expiring on its timer. An
   * arm that fires mid-hang on an ALIVE run is a STALL: the lane
   * re-issues the chunk's still-unfilled cards ONCE on a fresh arm
   * (issue #104 — a hang must not park cards to raw while anything
   * still answers). A second stall, or any endpoint-answered failure,
   * degrades to rule-5 on ITS cards only (spec §4: degrade only the
   * unfinished items), and a stuck lane never holds the cursor hostage.
   * Claim-cursor is synchronous — no double-claim; each lane's merge is
   * one synchronous rewrite (disjoint indices), so lanes can't clobber
   * each other. Cached interpretations return instantly — the first
   * chunk (viewport cards) still starts at t=0 on lane 0.
   *
   * Lazy fill (issue #106): decode is the real cost (~12.5s per 3-card
   * chunk), and on a long result a third of the cards are never scrolled
   * to — with `lazy` the claim gate only takes ARMED chunks (the ruled
   * next-N prefetch: the viewport plus ~2 screenfuls ahead, armed by the
   * results surface's IntersectionObserver; chunk 0 is armed at t0 so
   * spec §7's first-content contract holds with zero scroll). Cards
   * beyond the armed window stay raw and UN-ambered — amber means a lane
   * asked and lost, these were never asked (spec §2). Arming is sticky
   * and a chunk claims at most once per fill, so scroll-back never
   * re-pays the endpoint: a re-armed chunk's records either already
   * painted or ride the (eventId, model) cache pass inside fillCards
   * (spec §6). With `lazy = false` every chunk counts as armed and the
   * gate degrades to the old linear cursor — that stays the test-seam
   * default so fills without an arming surface behave exactly as before. */
  private async fillInChunks(
    provider: ProviderOverrideInput,
    callLLM: CallLLM,
    controller: AbortController,
    stream?: StreamLLM,
    lazy: boolean = false,
    // 60s: a cold model on a shared BYOK gateway can take 30-60s to answer
    // at all (first-use cold-loads are common on LiteLLM-style proxies), and
    // the gateway's 429 cooldown cycle needs a lane arm longer than its
    // Retry-After horizon (capped at 15s, issue #53) — 10s mislabeled honest
    // waits as timeouts (every fill chunk died at exactly ~10s on a
    // measured-fast endpoint, owner incident).
    perChunkMs: number = 60_000,
  ): Promise<void> {
    const CHUNK = 3;
    const LANES = 4;
    const total = this.cards.length;
    // Capture the fill context for this run (#106): a scroll-armed cycle
    // must re-fill with the SAME provider + transport — never live
    // settings (a mid-run model change would poison the (eventId, model)
    // cache keys with a different model's rows).
    this.fillCtx = { provider, callLLM, stream };
    // Seed from the live array, never zero (review P2 on the first #118
    // pass): the top-up leg re-enters here AFTER the early leg interpreted
    // cards, and a 0-seed leaves "0 of N filled" on the trace row and the
    // aria-live verdict forever — the decouple counter must never read raw
    // beside interpreted cards (spec §2 rule 6).
    this.syncFillStats(this.cards);
    // the gateway's page-lifetime 429 count across THIS fill — snapshot at
    // entry, settle at the end of the last lane.
    const seen429AtStart = surfaced429Count();
    // Arming set (#106): STICKY ACROSS CYCLES within a run (a scrolled-past
    // card must not drop back out between cycles) — resetRun clears it for
    // the next run. Claimed ranges are per-cycle: a re-armed chunk's
    // already-filled cards ride the (eventId, model) cache pass inside
    // fillCards, so a second claim never re-pays the endpoint (spec §6).
    const chunkCount = Math.ceil(total / CHUNK);
    const claimedRanges = new Set<number>();
    /** A card the lanes can still do work on (#106 cycle model): not yet
     * interpreted AND not amber — a claimed-and-lost card never re-enters
     * a cycle (the gateway already retried it; re-asking would re-pay for
     * the same loss), and an interpreted one has nothing left to do. */
    const hasWork = (i: number): boolean => {
      const c = this.cards[i];
      return c !== undefined && !c.interpreted && !this.failed.has(c.id);
    };
    /** Lazy claim gate (#106): a chunk is claimable when any of its cards
     * is armed AND has work — chunk 0 included (the t0 viewport guarantee,
     * spec §7 — but never above hasWork: an all-interpreted chunk 0 must
     * not re-claim every cycle, and an amber one never re-pays). Eager
     * fills short-circuit true so the cursor below is then exactly the
     * pre-#106 smallest-unclaimed walk. */
    const chunkArmed = (at: number): boolean => {
      if (!lazy) return true;
      const end = Math.min(at + CHUNK, total);
      let hasWorkInRange = false;
      let armedHasWork = false;
      for (let i = at; i < end; i++) {
        if (!hasWork(i)) continue;
        hasWorkInRange = true;
        if (this.armed.has(this.cards[i]?.id ?? "")) armedHasWork = true;
      }
      return (at === 0 && hasWorkInRange) || armedHasWork;
    };
    /** Smallest unclaimed ARMED chunk, claimed synchronously (no
     * double-claim), or null when nothing armed-and-unclaimed exists.
     * Smallest-first keeps the fill ordered the way the user reads even
     * after a scroll jump arms a deep chunk. */
    const claim = (): number | null => {
      for (let at = 0; at < total; at += CHUNK) {
        if (claimedRanges.has(at) || !chunkArmed(at)) continue;
        claimedRanges.add(at);
        return at;
      }
      return null;
    };
    const runAlive = (): boolean =>
      !controller.signal.aborted && this.controller === controller;
    /** One fill pass over `passCards`: claim → pending, a fresh arm, the
     * fillCards call (onPaint mapping via indexOf), the pending-out
     * settle, the amber failed-set bookkeeping, and the fillStats
     * recompute — the per-chunk lifecycle, parameterized so the worker
     * can re-run it for a stalled chunk's remainder (issue #104).
     * Returns true when the pass STALLED: an abort-shaped throw escaped
     * fillCards while the run is alive (the chunk arm fired on a hang,
     * or the gateway's attempt timeout surfaced through records'
     * rethrow). */
    const runPass = async (
      passCards: ProductCard[],
      indexOf: (card: ProductCard, i: number) => number,
      armMs: number,
    ): Promise<boolean> => {
      // Claim → pending: the pass's ids flip to `interpreting…` NOW —
      // before the fetch fire — so a card mid-fire never reads
      // identically to one that will never be interpreted (spec §2).
      // Copy-on-write Set so the badge re-fires per claim.
      const claimed = new Set(this.pending);
      for (const c of passCards) claimed.add(c.id);
      this.pending = claimed;
      const timer = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(armMs),
      ]);
      let filled = passCards;
      let stalled = false;
      try {
        // A chunk timing out (or its interpretation read failing)
        // aborts ONLY its own combined signal — generateRecords
        // rethrows aborted-signal errors, so without this catch the
        // timer's abort would escape into start()'s error path on a
        // healthy run and pin filling=true forever (spec §4).
        filled = await fillCards(passCards, {
          provider,
          callLLM,
          // Streamed fill (issue #64): the chunk's cards paint ONE RECORD
          // AT A TIME as its blocks decode inside the open stream —
          // the first filled card lands near that card's own decode time
          // instead of after the whole 3-card batch. The streamed view
          // passes the same id-affinity gate as the settle pass, so the
          // two views of a card can never disagree.
          streamLLM: stream,
          // Lanes write disjoint index ranges (one claim chunk each) and
          // this is one synchronous array-rewrite per paint — the same
          // clobber-free contract as the settle merge below, just earlier.
          onPaint: (card, i) => {
            if (this.controller !== controller) return;
            const merged = this.cards.slice();
            merged[indexOf(card, i)] = card;
            this.cards = merged;
            // Live denominator (issue #118): the post-context merge can
            // append arrivals mid-leg, so the banner counts against the
            // array as it stands — never the leg-entry count.
            this.syncFillStats(merged);
            // Drafting voice ends here (issue #109): the live face owns
            // the card's text from the paint on — its pre-gate draft is
            // removed, never persisted.
            if (this.drafts.has(card.id)) {
              const revoked = new Map(this.drafts);
              revoked.delete(card.id);
              this.drafts = revoked;
            }
          },
          // Drafting voice (issue #109, spec §9): the pre-gate tail,
          // already affinity-gated and clipped upstream — written to the
          // run-scoped overlay the dashed face reads. A null draft revokes
          // exactly that card (its trailing block completed: it painted
          // above, or its verdict lands at settle below). No-op deltas
          // (same parse twice, absent delete) keep Map identity so the
          // cards don't re-render for nothing.
          onDraft: (cardId, draft) => {
            if (this.controller !== controller) return;
            if (draft === null) {
              if (!this.drafts.has(cardId)) return;
              const revoked = new Map(this.drafts);
              revoked.delete(cardId);
              this.drafts = revoked;
              return;
            }
            const prev = this.drafts.get(cardId);
            if (
              prev !== undefined &&
              prev.title === draft.title &&
              prev.snippet === draft.snippet
            )
              return;
            const nextDrafts = new Map(this.drafts);
            nextDrafts.set(cardId, draft);
            this.drafts = nextDrafts;
          },
          signal: timer,
          // schema_failure (it answered, output didn't conform) and
          // rate_limited (it answered 429, asking us to slow down) both
          // prove the endpoint was REACHABLE — sticky, so a later
          // transport failure on another lane can't overwrite that truth
          // (spec §2 never-lie). recordFillFailure pins the pairing.
          onFailure: (kind, message) => {
            recordFillFailure(this, kind, message);
          },
        });
      } catch (err) {
        // Stall vs stop (issue #104): what escapes fillCards is
        // abort-shaped by construction (records rethrows aborts; an
        // endpoint-answered failure is an AIResult). On an ALIVE run
        // that's a stalled pass and the worker re-issues its remainder
        // once; on a stopped run it's the §8 abort lifecycle — settle
        // quietly here, flag down.
        stalled = runAlive() && isAbortShaped(err);
      }
      // Merge → pending-out: the pass's ids leave regardless of outcome
      // — a settle (interpreted, rule-5 fallback, or lane drop under an
      // abort) is a settle, never a mid-flight lie (spec §2). Runs even
      // when the controller swapped out mid-flight so a dead run's
      // leaked ids can't pin `interpreting…` forever.
      const settle = new Set(this.pending);
      for (const c of passCards) settle.delete(c.id);
      this.pending = settle;
      // Silent revoke (issue #109, spec §9 drafting voice): whatever of
      // this pass's drafts survived to settle ends HERE — painted, settled
      // raw, gate-rejected, or the pass died. A draft must never outlive
      // the settle of the block it previewed; like the pending-out above,
      // this runs even on a superseded run so a dead run's drafts can
      // never leak onto cards the next run owns.
      if (this.drafts.size > 0) {
        const revoked = new Map(this.drafts);
        let changed = false;
        for (const c of passCards) changed = revoked.delete(c.id) || changed;
        if (changed) this.drafts = revoked;
      }
      if (this.controller !== controller) return false;
      // One synchronous merge over disjoint indices — the lanes can't
      // clobber each other's writes; UI paints per chunk. Amber
      // bookkeeping (issue #82) rides the same pass: a claimed card that
      // settled WITHOUT an interpretation marks `failed`; one the pass
      // interpreted (live or cache-hit) drains. This runs only on the
      // current controller's path — a superseded run returned above,
      // so stopped runs never mark (killed ≠ failed — §8 abort
      // lifecycle; §2 never-lie). */
      const merged = this.cards.slice();
      const failedSet = new Set(this.failed);
      for (let i = 0; i < filled.length; i++) {
        const at = indexOf(filled[i], i);
        const live = merged[at];
        // A stalled pass resolves with the ORIGINAL raw cards — its
        // onPaint-painted cards are already merged and are strictly more
        // advanced truth (issue #104: painted cards never revert to raw;
        // the re-issue only asks for the still-unfilled remainder).
        if (live !== undefined && live.interpreted && !filled[i].interpreted) continue;
        merged[at] = filled[i];
        if (filled[i].interpreted) failedSet.delete(filled[i].id);
        else failedSet.add(filled[i].id);
      }
      this.cards = merged;
      this.failed = failedSet;
      // Live denominator, same as onPaint above (issue #118).
      this.syncFillStats(merged);
      return stalled;
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted || this.controller !== controller) return;
        const at = claim();
        if (at === null) {
          // Nothing armed-and-unclaimed exists right now. With every chunk
          // claimed the lane's work is done (the eager path always exits
          // here — claim() only returns null once the cursor is spent).
          // Otherwise the fill is lazy and ahead-of-viewport chunks just
          // aren't armed yet — the CYCLE EXITS (owner blocker, 2026-09-28):
          // fillInChunks resolves, filling goes false (the §4 banner and
          // keyArrived's guard both read it), and the next armChunk()
          // starts a fresh cycle over the armed remainder. A lane never
          // spins on the gate and never hangs a stopped run (spec §8).
          return;
        }
        const chunk = this.cards.slice(at, at + CHUNK);
        const stalled = await runPass(chunk, (_card, i) => at + i, perChunkMs);
        if (!stalled) continue;
        if (controller.signal.aborted || this.controller !== controller) return;
        // Kill-and-reissue (issue #104): the pass stalled on a live run —
        // re-issue ONLY the chunk's still-unfilled cards, once, on a fresh
        // arm. Cards painted via onPaint before the kill keep their paint
        // (they are interpreted and drop out of `remaining`), and the
        // (eventId, model) cache semantics are unchanged — fillCards' own
        // cache pass runs as usual. If this pass stalls or fails too, the
        // remainder settles raw: the gateway already retried
        // endpoint-answered failures, and a twice-hung chunk is not ours
        // to keep hammering (spec §2/§4).
        const rangeCards = this.cards.slice(at, at + CHUNK);
        const remaining = rangeCards.filter((c) => !c.interpreted);
        if (remaining.length === 0) continue;
        const byId = new Map(rangeCards.map((c, i) => [c.id, at + i]));
        await runPass(
          remaining,
          (c) => byId.get(c.id) ?? at, // remaining ⊆ the chunk range — the miss branch is unreachable
          perChunkMs,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LANES, Math.ceil(total / CHUNK)) },
        () => worker(),
      ),
    );
    // Settle the #105 count: what the endpoint actually said across this
    // fill's lanes (reissue passes included — they ride the same gateway).
    this.rateLimitedCount = surfaced429Count() - seen429AtStart;
  }

  /** @internal — test seam for the fill lane (issue #59): seeds cards, arms
   * a fresh controller (so `this.controller !== controller` bail-outs stay
   * off the happy path), and runs one fillInChunks cycle against this
   * instance, optionally with a shorter per-chunk arm (issue #104).
   * `opts.lazy` turns on the #106 claim gate — tests then drive the SAME
   * armChunk() entry point the results surface's observer uses, no
   * IntersectionObserver needed. Default false: no arming surface means
   * every chunk counts as armed, exactly the pre-#106 behavior.
   * `opts.stream` arms the streamed fill (issue #64) instead of the batch
   * path — the #109 draft-stream tests drive that seam. Underscore-marked
   * like `_closeForTests`; UI callers go through `start()`. */
  async _fillInChunksForTests(
    cards: ProductCard[],
    provider: ProviderOverrideInput,
    callLLM: CallLLM,
    perChunkMs?: number,
    opts: { lazy?: boolean; stream?: StreamLLM } = {},
  ): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.cards = cards;
    this.filling = true;
    this.fillStats = { interpreted: 0, total: cards.length };
    this.pending = new Set();
    this.drafts = new Map(); // a fresh seam run owns a fresh drafting voice (#109)
    await this.fillInChunks(
      provider,
      callLLM,
      controller,
      opts.stream,
      opts.lazy ?? false,
      perChunkMs,
    );
    this.filling = false;
  }
}

export const investigation = new Investigation();

/** Test seam — same shape as resetShell/resetSettings. */
export function resetInvestigation(): void {
  investigation.stop();
  investigation.phase = "idle";
  investigation.slices = [];
  investigation.searches = [];
  investigation.skeletons = [];
  investigation.notices = [];
  investigation.result = null;
  investigation.error = null;
  investigation.elapsedMs = null;
  investigation.cards = [];
  investigation.facetGroups = [];
  investigation.selections = {};
  investigation.filling = false;
  investigation.resetArming();
  investigation.pending = new Set();
  investigation.failed = new Set();
  investigation.drafts = new Map();
  investigation.fillStats = { interpreted: 0, total: 0 };
  investigation.fillFailure = null;
  investigation.fillErrorMessage = null;
  investigation.rateLimitedCount = 0;
  investigation.lastQuestion = "";
  investigation.sessionId = null;
  investigation.restoredEvicted = null;
  investigation.restoreMissId = null;
  investigation.selectedEventId = null;
  investigation.graphSubjectId = null;
  investigation.expandedRelated = [];
  investigation.expandedBridges = [];
  investigation.expansionLog = [];
  investigation.hasShareHints = false;
  investigation.contextFetched = new Set();
  investigation.shareHints = [];
  investigation._resetNodeFill();
  investigation.running = false;
}

/**
 * Results-surface banner text for the card-fill lane (spec §6 deterministic
 * wording — never AI-written). Distinguishes a dead endpoint (unreachable/
 * timeout), one blocked by the browser before any HTTP response (browser_blocked
 * — CORS preflight / mixed content, spec §2), one throttling us (rate_limited
 * — a 429 IS an answer: the endpoint is up, just asking us to slow down), and
 * one that answered but produced non-conforming output (schema_failure): the
 * last two must not be mislabeled "Endpoint unreachable" (spec §2 never-lie — in the
 * owner's incident the endpoint WAS reachable), and a browser block must not
 * claim the endpoint is down. User-visible text speaks issue #108's
 * raw/filled vocabulary — never "AI" or "interpreted".
 */
/** Fill-failure recording rule, exported for the ordering pin: schema_failure
 * and rate_limited are sticky — a later transport error can't overwrite "the
 * AI was reachable" (spec §2 never-lie). The message obeys the same priority:
 * only the WINNING kind may pair its reason, else the banner could show an
 * unreachable-flavored message under a schema_failure/rate_limited kind. */
export function recordFillFailure(
  target: Pick<Investigation, "fillFailure" | "fillErrorMessage">,
  kind: AIKind,
  message?: string,
): void {
  if (target.fillFailure === "schema_failure" || target.fillFailure === "rate_limited") return;
  target.fillFailure = kind;
  if (typeof message === "string") {
    target.fillErrorMessage = message.length > 140 ? message.slice(0, 139) + "…" : message;
  }
}

export function fillNote(
  interpreted: number,
  total: number,
  failure: AIKind | null,
  message: string | null = null,
  /** 429s the gateway saw during this run (issue #105). Rides as a
   * trailing suffix so #108's rewording of the head sentence leaves it
   * intact; 0 = the retries cleared everything, nothing to add. */
  rateLimitedCount = 0,
): string {
  if (total <= 0 || interpreted >= total) return "";
  if (interpreted > 0) {
    return `Slow — ${interpreted} of ${total} cards filled · the rest show the raw events`;
  }
  const reason = message === null || message === "" ? "" : ` (${message})`;
  if (failure === "schema_failure") {
    return `Output didn't conform${reason} — cards show the raw events`;
  }
  if (failure === "rate_limited") {
    const countSuffix = rateLimitedCount > 0 ? ` · endpoint rate limited ${rateLimitedCount}×` : "";
    return `Endpoint rate limited — cards show the raw events${countSuffix}`;
  }
  if (failure === "browser_blocked") {
    return "Endpoint blocked by the browser (CORS or mixed content) — cards show the raw events";
  }
  return `Endpoint unreachable${reason} — cards show the raw events`;
}
