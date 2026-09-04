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

import { defaultCallLLM, type CallLLM } from '$lib/ai/output';
import type { ProviderOverrideInput } from '$lib/ai/provider';
import { createTransport, type Transport } from '$lib/net/transport';
import {
	runSearch,
	type Phase,
	type PipelineEvent,
	type PipelineNotice,
	type SearchSession,
	type SkeletonCard
} from '$lib/pipeline';
import type { SearchRequest } from '$lib/ai/agents/query';
import { resolveGraph } from '$lib/fabric';
import {
	assembleCards,
	computeFacets,
	fillCards,
	type FacetGroup,
	type ProductCard
} from '$lib/pipeline/cards';
import { settings } from '$lib/settings.svelte';
import { shell } from '$lib/shell.svelte';

class Investigation {
	phase = $state<Phase | 'idle'>('idle');
	/** Per-relay slice receipts, in arrival order — the trace's literal layer. */
	slices = $state<
		{ url: string; received: number; route: string; rejected: number; status: 'ok' | 'timeout' | 'refused' }[]
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
	fillStats = $state<{ interpreted: number; total: number }>({ interpreted: 0, total: 0 });
	result = $state<SearchSession | null>(null);
	/** Settled failure (never a deliberate abort); the §4 error surfaces
	 * (#38) render from this. */
	error = $state<string | null>(null);
	running = $state(false);

	/** Wall time of the settled run (ms) — the done row's "· 4.2s". */
	elapsedMs = $state<number | null>(null);
	/** The question as asked — the error screen's Retry re-fires it (spec §4). */
	lastQuestion = $state('');

	private controller: AbortController | null = null;

	private applyEvent(controller: AbortController, event: PipelineEvent): void {
		// Only the current run may write — an aborted run's late events die here.
		if (this.controller !== controller) return;
		switch (event.type) {
			case 'phase':
				this.phase = event.phase;
				break;
			case 'slice':
				this.slices.push({
					url: event.url,
					received: event.received,
					route: event.route,
					rejected: event.rejected,
					status: event.status
				});
				break;
			case 'searches':
				this.searches = event.searches;
				break;
			case 'skeleton':
				this.skeletons.push(...event.cards);
				break;
			case 'notice':
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
		this.phase = 'idle';
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
		this.fillStats = { interpreted: 0, total: 0 };
		this.elapsedMs = null;
		this.running = true;
		const startedAt = performance.now();

		// The session row exists before the first slice so the rail shows the
		// investigation even if every relay hangs (spec §4: never demo data,
		// but the question itself is real user input).
		shell.newSession(question);
		// issue #36: submit lands on the trace/results stage (spec center
		// swap search → results → session); the graph session is #29's.
		shell.view = 'results';

		const provider: ProviderOverrideInput | undefined =
			settings.apiKey === ''
				? undefined
				: {
						baseUrl: settings.endpoint,
						model: settings.model,
						apiKey: settings.apiKey
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
				emit: (event) => this.applyEvent(controller, event)
			});
			// The transport never sees the abort signal, so a superseded
			// run RESOLVES instead of throwing — the terminal write takes
			// the same identity guard as the sibling writes (review P1).
			if (this.controller === controller) {
				this.result = session;
				this.cards =
					session.admitted.length === 0
						? []
						: assembleCards(resolveGraph(session.admitted), session.admitted);
				this.facetGroups = computeFacets(session.admitted);
				if (provider !== undefined && settings.model !== '' && this.cards.length > 0) {
					this.filling = true;
					await this.fillInChunks(provider, callLLM, controller);
					if (this.controller === controller) this.filling = false;
				}
			}
		} catch (err) {
			// Deliberate aborts are not errors; real failures settle into the
			// §4 error surface's input instead of an unhandled rejection.
			if (this.controller === controller && !controller.signal.aborted) {
				this.error = err instanceof Error ? err.message : String(err);
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
		this.controller?.abort();
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
	 * interpreted within ~10s — the batch never blocks the whole set).
	 * 4-card batches through fillCards; each chunk gets a 10s arm — a
	 * timed-out chunk leaves its cards on the rule-5 fallback and the
	 * NEXT chunk still runs (spec §4: degrade only the unfinished
	 * items). Cached interpretations come back instantly (first chunk is
	 * paint), so the first-visible cards fill first. */
	private async fillInChunks(
		provider: ProviderOverrideInput,
		callLLM: CallLLM,
		controller: AbortController
	): Promise<void> {
		const CHUNK = 4;
		const PER_CHUNK_MS = 10_000;
		const total = this.cards.length;
		this.fillStats = { interpreted: 0, total };
		for (let at = 0; at < total; at += CHUNK) {
			if (controller.signal.aborted || this.controller !== controller) return;
			const chunk = this.cards.slice(at, at + CHUNK);
			const timer = AbortSignal.any([controller.signal, AbortSignal.timeout(PER_CHUNK_MS)]);
			const filled = await fillCards(chunk, { provider, callLLM, signal: timer });
			if (this.controller !== controller) return;
			// Merge: newer cards array instance each chunk so the UI paints
			// per chunk rather than at the very end.
			const next = this.cards.slice();
			for (let i = 0; i < filled.length; i++) next[at + i] = filled[i];
			this.cards = next;
			this.fillStats = { interpreted: next.filter((c) => c.interpreted).length, total };
		}
	}
}

export const investigation = new Investigation();

/** Test seam — same shape as resetShell/resetSettings. */
export function resetInvestigation(): void {
	investigation.stop();
	investigation.phase = 'idle';
	investigation.slices = [];
	investigation.searches = [];
	investigation.skeletons = [];
	investigation.notices = [];
	investigation.result = null;
	investigation.error = null;
	investigation.elapsedMs = null;
	investigation.running = false;
}
