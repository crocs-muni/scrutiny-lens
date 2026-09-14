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
import { streamLLM } from "$lib/ai/gateway";
import type { StreamLLM } from "$lib/ai/records";
import type { ProviderOverrideInput } from "$lib/ai/provider";
import { createTransport, type Transport } from "$lib/net/transport";
import {
  runSearch,
  type Phase,
  type PipelineEvent,
  type PipelineNotice,
  type SearchSession,
  type SkeletonCard,
} from "$lib/pipeline";
import type { SearchRequest } from "$lib/ai/agents/query";
import {
  admitBatch,
  resolveGraph,
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
  computeFacets,
  fillCards,
  type FacetGroup,
  type ProductCard,
} from "$lib/pipeline/cards";
import { settings } from "$lib/settings.svelte";
import { shell } from "$lib/shell.svelte";

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

/** Per-lane first-fire pause (issue #59): staggers the four fill lanes so
 * the endpoint never sees 4 chunks in one tick — 1.5s × laneIndex (0 / 1.5
 * / 3 / 4.5s) against the all-at-once burst that measured the 429 slowness
 * this morning. Set this to 0 once the gateway (PR #56) lands
 * serialized-pacing at the transport layer: its cap-2 FIFO then serializes
 * the lanes itself and this is dead weight. Until then the value is a
 * UI-lane cap, not a transport cap — the gateway owns the real pacing. */
const LANE_STAGGER_MS = 1_500;

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
  fillStats = $state<{ interpreted: number; total: number }>({
    interpreted: 0,
    total: 0,
  });
  /** Settle-kind of the fill lane (null = no fill failure recorded): lets the
   * results banner say why cards aren't interpreted — a dead endpoint vs one
   * that answered but whose output didn't conform (spec §2 never-lie). */
  fillFailure = $state<AIKind | null>(null);
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

  /** The selected dossier subject (issue #29a, ADR 0001): store-level —
   * facet filters and view hops never clear it; it dies exactly where the
   * investigation itself dies (start/stop/reset). No deselect gesture
   * (ruling 10). */
  selectedEventId = $state<string | null>(null);

  /** Subjects whose §8.2 dossier context was fetched (or is in flight) —
   * one traversal per subject per session; dies with the session (start()
   * re-creates it with the rest of the run's state). */
  contextFetched = new Set<string>();

  private controller: AbortController | null = null;

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

  /** Start a search from the J1 composer. The transport and provider are
   * constructed per run from live settings — edits in Settings take effect
   * on the next question, never mid-run. */
  async start(question: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.phase = "idle";
    this.lastQuestion = question;
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
    this.pending = new Set();
    this.fillStats = { interpreted: 0, total: 0 };
    this.fillFailure = null;
    this.elapsedMs = null;
    this.selectedEventId = null;
    this.contextFetched = new Set();
    this.running = true;
    const startedAt = performance.now();

    // The session row exists before the first slice so the rail shows the
    // investigation even if every relay hangs (spec §4: never demo data,
    // but the question itself is real user input).
    shell.newSession(question);
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
        this.cards = assembleCards(
          resolveGraph(session.admitted),
          session.admitted,
        );
        this.facetGroups = computeFacets(session.admitted);
        // §8.2 settle traversal (lens #68), fire-and-forget. Parameterless
        // on purpose — refreshSessionContext documents the $state proxy trap.
        void this.refreshSessionContext();
        if (
          provider !== undefined &&
          settings.model !== "" &&
          this.cards.length > 0
        ) {
          this.filling = true;
          // Prod passes the gateway's streamText lane: the fill paints
          // per-record. Tests injecting only callLLM keep the batch path.
          await this.fillInChunks(
            provider,
            callLLM,
            controller,
            LANE_STAGGER_MS,
            streamLLM,
          );
          if (this.controller === controller) this.filling = false;
        }
      }
    } catch (err) {
      // Deliberate aborts are not errors; real failures settle into the
      // §4 error surface's input instead of an unhandled rejection.
      if (this.controller === controller && !controller.signal.aborted) {
        this.error = err instanceof Error ? err.message : String(err);
        this.filling = false;
      }
    } finally {
      // One pool per run: close its relay websockets when it settles.
      await transport?.close();
      if (this.controller === controller) {
        this.running = false;
        this.elapsedMs = Math.round(performance.now() - startedAt);
      }
    }
  }

  /** Abort the in-flight run (spec §8) without clearing what it already
   * painted — the abort settles it through the same finally path. */
  stop(): void {
    // Selection survives an abort (ruling 10): stop() freezes the run but
    // keeps what it painted, so the dossier's evidence is still intact.
    this.controller?.abort();
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
      for (const event of fresh) {
        session.admitted.push(event);
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
   * the bindings' missing endpoints. Fire-and-forget like the dossier legs:
   * appends to session.admitted re-derive the dossier in place; facet
   * groups/cards/graph deliberately do not re-run (§3: those are the
   * search's shape). Settled too early to block the fill lane. */
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
   * Each chunk keeps its own 25s arm — past the gateway's 429-cooldown
   * horizon (Retry-After capped at 15s, issue #53) so a lane survives one
   * cooldown cycle in-queue instead of expiring on its timer. A timed-out
   * chunk degrades to rule-5 on ITS 3 cards only (spec §4: degrade only
   * the unfinished items), and a stuck lane never holds the cursor hostage.
   * Claim-cursor is synchronous — no double-claim; each lane's merge is
   * one synchronous rewrite (disjoint indices), so lanes can't clobber
   * each other. Cached interpretations return instantly — the first
   * chunk (viewport cards) still starts at t=0 on lane 0. */
  private async fillInChunks(
    provider: ProviderOverrideInput,
    callLLM: CallLLM,
    controller: AbortController,
    laneStaggerMs: number = LANE_STAGGER_MS,
    stream?: StreamLLM,
  ): Promise<void> {
    const CHUNK = 3;
    const LANES = 4;
    // 60s: a cold model on a shared BYOK gateway can take 30-60s to answer
    // at all (first-use cold-loads are common on LiteLLM-style proxies), and
    // the gateway's 429 cooldown cycle needs a lane arm longer than its
    // Retry-After horizon (capped at 15s, issue #53) — 10s mislabeled honest
    // waits as timeouts (every fill chunk died at exactly ~10s on a
    // measured-fast endpoint, owner incident).
    const PER_CHUNK_MS = 60_000;
    const total = this.cards.length;
    this.fillStats = { interpreted: 0, total };
    let next = 0;
    const claim = (): number => {
      const at = next;
      next += CHUNK;
      return at;
    };
    const worker = async (laneIndex: number): Promise<void> => {
      for (let at = claim(); at < total; at = claim()) {
        if (controller.signal.aborted || this.controller !== controller) return;
        // First-fire stagger (issue #59): lane k sleeps k·laneStaggerMs
        // before its FIRST claim (at === laneIndex·CHUNK is true on exactly
        // one iteration per lane) — later claims fire the moment the
        // previous chunk settles, or the wall-clock penalty would outgrow
        // the pacing win. Lane 0 (viewport cards first) still fires at t=0.
        if (laneIndex > 0 && at === laneIndex * CHUNK) {
          await sleep(laneIndex * laneStaggerMs, controller.signal);
          if (controller.signal.aborted || this.controller !== controller) return;
        }
        const chunk = this.cards.slice(at, at + CHUNK);
        // Claim → pending: the chunk's ids flip to `interpreting…` NOW —
        // before the fetch fire — so a card mid-fire never reads
        // identically to one that will never be interpreted (spec §2).
        // Copy-on-write Set so the badge re-fires per claim.
        const claimed = new Set(this.pending);
        for (const c of chunk) claimed.add(c.id);
        this.pending = claimed;
        const timer = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(PER_CHUNK_MS),
        ]);
        let filled = chunk;
        try {
          // A chunk timing out (or its interpretation read failing)
          // aborts ONLY its own combined signal — generateRecords
          // rethrows aborted-signal errors, so without this catch the
          // timer's abort would escape into start()'s error path on a
          // healthy run and pin filling=true forever (spec §4).
          filled = await fillCards(chunk, {
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
              merged[at + i] = card;
              this.cards = merged;
              this.fillStats = {
                interpreted: merged.filter((c) => c.interpreted).length,
                total,
              };
            },
            signal: timer,
            // schema_failure (it answered, output didn't conform) and
            // rate_limited (it answered 429, asking us to slow down) both
            // prove the endpoint was REACHABLE — sticky, so a later
            // transport failure on another lane can't overwrite that truth
            // (spec §2 never-lie).
            onFailure: (kind) => {
              this.fillFailure =
                this.fillFailure === "schema_failure" ||
                this.fillFailure === "rate_limited"
                  ? this.fillFailure
                  : kind;
            },
          });
        } catch {
          // rule-5 fallback for this chunk; the lane keeps going.
        }
        // Merge → pending-out: the chunk's ids leave regardless of outcome
        // — a settle (interpreted, rule-5 fallback, or lane drop under an
        // abort) is a settle, never a mid-flight lie (spec §2). Runs even
        // when the controller swapped out mid-flight so a dead run's
        // leaked ids can't pin `interpreting…` forever.
        const settle = new Set(this.pending);
        for (const c of chunk) settle.delete(c.id);
        this.pending = settle;
        if (this.controller !== controller) return;
        // One synchronous merge over disjoint indices — the lanes can't
        // clobber each other's writes; UI paints per chunk.
        const merged = this.cards.slice();
        for (let i = 0; i < filled.length; i++) merged[at + i] = filled[i];
        this.cards = merged;
        this.fillStats = {
          interpreted: merged.filter((c) => c.interpreted).length,
          total,
        };
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LANES, Math.ceil(total / CHUNK)) },
        (_, i) => worker(i),
      ),
    );
  }

  /** @internal — test seam for the fill lane (issue #59): seeds cards, arms
   * a fresh controller (so `this.controller !== controller` bail-outs stay
   * off the happy path), and runs one fillInChunks cycle against this
   * instance with a caller-chosen stagger. Underscore-marked like
   * `_closeForTests`; UI callers go through `start()`. */
  async _fillInChunksForTests(
    cards: ProductCard[],
    provider: ProviderOverrideInput,
    callLLM: CallLLM,
    laneStaggerMs: number = 0,
  ): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.cards = cards;
    this.filling = true;
    this.fillStats = { interpreted: 0, total: cards.length };
    this.pending = new Set();
    await this.fillInChunks(provider, callLLM, controller, laneStaggerMs);
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
  investigation.pending = new Set();
  investigation.fillStats = { interpreted: 0, total: 0 };
  investigation.fillFailure = null;
  investigation.selectedEventId = null;
  investigation.contextFetched = new Set();
  investigation.running = false;
}

/**
 * Results-surface banner text for the card-fill lane (spec §6 deterministic
 * wording — never AI-written). Distinguishes a dead endpoint (unreachable/
 * timeout), one blocked by the browser before any HTTP response (browser_blocked
 * — CORS preflight / mixed content, spec §2), one throttling us (rate_limited
 * — a 429 IS an answer: the endpoint is up, just asking us to slow down), and
 * one that answered but produced non-conforming output (schema_failure): the
 * last two must not be mislabeled "AI unreachable" (spec §2 never-lie — in the
 * owner's incident the endpoint WAS reachable), and a browser block must not
 * claim the AI is down.
 */
export function fillNote(
  interpreted: number,
  total: number,
  failure: AIKind | null,
): string {
  if (total <= 0 || interpreted >= total) return "";
  if (interpreted > 0) {
    return `AI slow — ${interpreted} of ${total} cards interpreted · uninterpreted cards show the raw events`;
  }
  if (failure === "schema_failure") {
    return "AI output didn't conform — cards show the raw events";
  }
  if (failure === "rate_limited") {
    return "AI endpoint rate limited — cards show the raw events";
  }
  if (failure === "browser_blocked") {
    return "AI endpoint blocked by the browser (CORS or mixed content) — cards show the raw events";
  }
  return "AI unreachable — cards show the raw events";
}
