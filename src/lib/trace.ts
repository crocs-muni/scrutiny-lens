// Trace derivation (issue #36, spec §2.1 rule 6): the three TaskRows phases
// and their counters computed deterministically from the investigation's
// pipeline state. AI writes nothing here — every label, counter, and tick
// is arithmetic over real retrieval state. Kept UI-free so the mapping is
// unit-testable without rendering.

import type { Phase, PipelineNotice } from '$lib/pipeline';
import type { SearchRequest } from '$lib/ai/agents/query';

export type RowStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface TraceTick {
	text: string;
	/** Amber = an honesty cell (scan fallback, truncation) — spec §3/§4. */
	warn?: boolean;
}

export interface PhaseRow {
	id: 'interpret' | 'sources' | 'decouple';
	label: string;
	status: RowStatus;
	/** Mono right counter (tabular-nums); empty while nothing real exists. */
	counter: string;
	ticks: TraceTick[];
	/** 0..1 during row-3 fill (ring sweep); null otherwise. */
	progress: number | null;
	/** Failed-row retry wiring (TaskTrace binds investigation retry). */
	onRetry?: () => void;
}

export interface TraceInput {
	phase: Phase | 'idle';
	searches: SearchRequest[];
	slices: { url: string; received: number; route: string; rejected: number; status: 'ok' | 'timeout' | 'refused' }[];
	/** Admitted events so far (rule-5 skeletons, spec §2 rule 5). */
	skeletons: { typeTag?: string }[];
	notices: PipelineNotice[];
	relayCount: number;
	error: string | null;
	/** Write-descriptions fill progress (#38): present once a fill attempt
	 * started; `running` while chunks are in flight. Absent = no attempt —
	 * row 3 then reports `not interpreted` (never a fabricated tally). */
	descriptions?: { running: boolean; interpreted: number; total: number };
}

const LABELS: Record<PhaseRow['id'], string> = {
	interpret: 'Interpreting query',
	sources: 'Querying sources',
	decouple: 'Decoupling and interpreting the events'
};

function hostOf(url: string): string {
	if (url === 'local-cache') return 'local cache';
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Row 1 counter: the searches as asked, mono. Empty while translating. */
function searchCounter(searches: SearchRequest[]): string {
	return searches.map((s) => s.value).join(' · ');
}

export function derivePhaseRows(input: TraceInput): PhaseRow[] {
	const { phase, searches, slices, notices, relayCount, error } = input;
	const done = phase === 'done';
	const failed = error !== null;

	const received = slices.reduce((sum, s) => sum + s.received, 0);
	const rejected = slices.reduce((sum, s) => sum + s.rejected, 0);
	const admitted = input.skeletons.length;
	// Only relays that actually answered count (review P1: a refused or
	// timed-out leg is a degradation, not a source) — counting them would
	// be the §3/§4 "no matches" vs "dead relay" conflation the trace
	// exists to prevent.
	const answered = new Set(
		slices.filter((s) => s.url !== 'local-cache' && s.status === 'ok').map((s) => s.url)
	).size;

	// The literal layer (spec §2 rule 6): per-slice receipts verbatim —
	// route label, relay, counts — plus honesty cells for scan fallbacks
	// and truncation. Nothing is smoothed over. Each tick is deduped by
	// exact text (first wins, order preserved): PhaseRow keys every tick by
	// text, so a repeated message (e.g. the same notice reaching the run
	// twice) would throw each_key_duplicate and brick the whole trace. The
	// same message legitimately lives in the banner AND here, but never
	// twice within this row.
	const ticks: TraceTick[] = [];
	const seenText = new Set<string>();
	const addTick = (tick: TraceTick): void => {
		if (seenText.has(tick.text)) return;
		seenText.add(tick.text);
		ticks.push(tick);
	};
	for (const s of slices) {
		// Non-ok legs render the status verbatim instead of pretending to be
		// an empty result (review P1): dead relay ≠ no matches (spec §3/§4).
		addTick({
			text:
				s.status === 'ok'
					? `${s.route} ${hostOf(s.url)} → ${s.received} records`
					: `relay ${hostOf(s.url)} ${s.status} · no events received`,
			// Fullscan legs are the honesty cells (spec §3: the relay couldn't
			// search, so we scanned) — amber, never silent.
			warn: s.status !== 'ok' || s.route.endsWith(':fullscan')
		});
	}
	for (const notice of notices) {
		addTick({ text: notice.message, warn: notice.kind === 'capability' || notice.kind === 'truncated' });
	}
	// Three rows (spec §2.1): interpret (translate) → sources (fetch) →
	// decouple (admit/reject + descriptions fill). Status is state-derived:
	// an errored run settles the running row to 'failed' and never leaves a
	// row spinning.
	const d = input.descriptions;

	const rows: PhaseRow[] = [
		{
			id: 'interpret',
			label: LABELS.interpret,
			status:
				done || phase === 'fetch'
					? 'completed'
					: failed
						? phase === 'translate'
							? 'failed'
							: 'skipped'
						: phase === 'translate'
							? 'running'
							: 'pending',
			counter: searchCounter(searches),
			ticks: [],
			progress: null
		},
		{
			id: 'sources',
			label: LABELS.sources,
			status: done ? 'completed' : failed ? 'skipped' : phase === 'fetch' ? 'running' : 'pending',
			counter:
				relayCount === 0
					? ''
					: done || phase === 'fetch'
						? `${answered} of ${relayCount} answered`
						: '',
			ticks,
			progress: null
		},
		{
			// Decouple runs while slices are in flight OR the descriptions
			// fill is in flight (lag guard: a done phase with a still-running
			// fill stays 'running' until the fill settles, spec §1.4).
			id: 'decouple',
			label: LABELS.decouple,
			status: failed
				? slices.length > 0 || d?.running
					? 'failed'
					: 'skipped'
				: done && !d?.running
					? 'completed'
					: d?.running
						? 'running'
						: slices.length === 0
							? 'pending'
							: phase === 'fetch'
								? 'running'
								: 'pending',
			counter:
				d?.running
					? `admitted ${admitted} · ${d.interpreted} of ${d.total} interpreted`
					: !d && done
						? `admitted ${admitted} · not interpreted`
						: d && !d.running && done
							? `admitted ${admitted} · ${d.interpreted} of ${d.total} interpreted`
							: !d && !done && slices.length > 0
								? `admitted ${admitted} · rejected ${rejected}`
								: '',
			progress: d?.running ? d.interpreted / Math.max(d.total, 1) : null,
			ticks:
				slices.length > 0
					? [
							{
								text: `decoupled ${received} raw events → ${admitted} admitted · ${rejected} rejected`
							}
						]
					: []
		}
	];
	return rows;
}

/** Done-row line (TR1): "Done. X products · Y metadata · Z sources · Ns" —
 * event-type counts per the owner ruling 2026-09-03 (spec §3 cohort line);
 * sources = answering relays + optional cache leg, from state only. */
export function doneLine(input: TraceInput): string {
	const answered = new Set(
		input.slices.filter((s) => s.url !== 'local-cache' && s.status === 'ok').map((s) => s.url)
	).size;
	const cached = input.slices.some((s) => s.url === 'local-cache');
	const sources = answered + (cached ? 1 : 0);
	const byType = new Map<string, number>();
	for (const card of input.skeletons ?? []) byType.set(card.typeTag ?? 'unknown', (byType.get(card.typeTag ?? 'unknown') ?? 0) + 1);
	const products = byType.get('scrutiny-product') ?? 0;
	const metadata = byType.get('scrutiny-metadata') ?? 0;
	const plural = (n: number, word: string, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;
	return `Done. ${plural(products, 'product')} · ${plural(metadata, 'metadata', '')} · ${plural(sources, 'source')}`;
}
