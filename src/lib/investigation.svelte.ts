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
import { createTransport } from '$lib/net/transport';
import {
	runSearch,
	type Phase,
	type PipelineEvent,
	type PipelineNotice,
	type SearchSession,
	type SkeletonCard
} from '$lib/pipeline';
import { settings } from '$lib/settings.svelte';
import { shell } from '$lib/shell.svelte';

class Investigation {
	phase = $state<Phase | 'idle'>('idle');
	/** Per-relay slice receipts, in arrival order — the trace's literal layer. */
	slices = $state<{ url: string; received: number; route: string }[]>([]);
	/** Rule-5 skeletons as they arrive (spec §2 rule 5). */
	skeletons = $state<SkeletonCard[]>([]);
	notices = $state<PipelineNotice[]>([]);
	result = $state<SearchSession | null>(null);
	/** Settled failure (never a deliberate abort); the §4 error surfaces
	 * (#38) render from this. */
	error = $state<string | null>(null);
	running = $state(false);

	private controller: AbortController | null = null;

	private applyEvent(controller: AbortController, event: PipelineEvent): void {
		// Only the current run may write — an aborted run's late events die here.
		if (this.controller !== controller) return;
		switch (event.type) {
			case 'phase':
				this.phase = event.phase;
				break;
			case 'slice':
				this.slices.push({ url: event.url, received: event.received, route: event.route });
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
		this.slices = [];
		this.skeletons = [];
		this.notices = [];
		this.result = null;
		this.error = null;
		this.running = true;

		// The session row exists before the first slice so the rail shows the
		// investigation even if every relay hangs (spec §4: never demo data,
		// but the question itself is real user input).
		shell.newSession(question);

		const provider: ProviderOverrideInput | undefined =
			settings.apiKey === ''
				? undefined
				: {
						baseUrl: settings.endpoint,
						model: settings.model,
						apiKey: settings.apiKey
					};
		const transport = createTransport({ urls: settings.relays });
		const callLLM: CallLLM = defaultCallLLM;

		try {
			this.result = await runSearch({
				question,
				relays: settings.relays,
				provider,
				callLLM,
				transport,
				signal: controller.signal,
				emit: (event) => this.applyEvent(controller, event)
			});
		} catch (err) {
			// Deliberate aborts are not errors; real failures settle into the
			// §4 error surface's input instead of an unhandled rejection.
			if (this.controller === controller && !controller.signal.aborted) {
				this.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			// One pool per run: close its relay websockets when it settles.
			await transport.close();
			if (this.controller === controller) this.running = false;
		}
	}

	/** Abort the in-flight run (spec §8) without clearing what it already
	 * painted — the abort settles it through the same finally path. */
	stop(): void {
		this.controller?.abort();
	}
}

export const investigation = new Investigation();

/** Test seam — same shape as resetShell/resetSettings. */
export function resetInvestigation(): void {
	investigation.stop();
	investigation.phase = 'idle';
	investigation.slices = [];
	investigation.skeletons = [];
	investigation.notices = [];
	investigation.result = null;
	investigation.error = null;
	investigation.running = false;
}
