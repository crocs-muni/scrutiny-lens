// Trace derivation (issue #36, spec §2 rule 6): the five TaskRows phases
// and their counters computed deterministically from the investigation's
// pipeline state. AI writes nothing here — every label, counter, and tick
// is arithmetic over real retrieval state. Kept UI-free so the mapping is
// unit-testable without rendering.

import type { Phase, PipelineNotice } from '$lib/pipeline';
import type { SearchRequest } from '$lib/ai/agents/query';

export type RowStatus = 'pending' | 'running' | 'completed' | 'skipped';

export interface TraceTick {
	text: string;
	/** Amber = an honesty cell (scan fallback, truncation) — spec §3/§4. */
	warn?: boolean;
}

export interface PhaseRow {
	id: 'question' | 'sources' | 'records' | 'organize' | 'descriptions';
	label: string;
	status: RowStatus;
	/** Mono right counter (tabular-nums); empty while nothing real exists. */
	counter: string;
	ticks: TraceTick[];
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
	 * started; `running` while chunks are in flight. Absent = no attempt
	 * (no key/model — the row stays honestly skipped, spec §2 rule 5). */
	descriptions?: { running: boolean; interpreted: number; total: number };
}

const LABELS: Record<PhaseRow['id'], string> = {
	question: 'Read the question',
	sources: 'Ask the sources',
	records: 'Collect the records',
	organize: 'Organize the picture',
	descriptions: 'Write descriptions'
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
	// and truncation. Nothing is smoothed over.
	const ticks: TraceTick[] = slices.map((s) => ({
		// Non-ok legs render the status verbatim instead of pretending to be
		// an empty result (review P1): dead relay ≠ no matches (spec §3/§4).
		text:
			s.status === 'ok'
				? `${s.route} ${hostOf(s.url)} → ${s.received} records`
				: `relay ${hostOf(s.url)} ${s.status} · no events received`,
		// Fullscan legs are the honesty cells (spec §3: the relay couldn't
		// search, so we scanned) — amber, never silent.
		warn: s.status !== 'ok' || s.route.endsWith(':fullscan')
	}));
	for (const notice of notices) {
		ticks.push({ text: notice.message, warn: notice.kind === 'capability' || notice.kind === 'truncated' });
	}
	// Row 5 decision tree (spec §2 rule 5 honesty): hoisted — it was two
	// parallel 4-deep ternaries re-deciding the same tree (review finding).
	const d = input.descriptions;
	let descStatus: RowStatus;
	let descCounter: string;
	if (failed) {
		descStatus = 'skipped';
		descCounter = '';
	} else if (d === undefined) {
		descStatus = done ? 'skipped' : 'pending';
		descCounter = done ? 'not interpreted' : '';
	} else if (d.running) {
		descStatus = 'running';
		descCounter = `${d.interpreted} of ${d.total}`;
	} else if (done) {
		descStatus = 'completed';
		descCounter = `${d.interpreted} of ${d.total} interpreted`;
	} else {
		descStatus = 'pending';
		descCounter = '';
	}

	const rows: PhaseRow[] = [
		{
			id: 'question',
			label: LABELS.question,
			status: done || phase === 'fetch' ? 'completed' : failed ? 'skipped' : phase === 'translate' ? 'running' : 'pending',
			counter: searchCounter(searches),
			ticks: []
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
			ticks
		},
		{
			id: 'records',
			label: LABELS.records,
			status: done ? 'completed' : failed ? 'skipped' : slices.length > 0 ? 'running' : 'pending',
			counter: slices.length > 0 ? (done ? `${received} records` : `${received} so far`) : '',
			ticks: []
		},
		{
			id: 'organize',
			label: LABELS.organize,
			status: done ? 'completed' : failed ? 'skipped' : slices.length > 0 ? 'running' : 'pending',
			counter: slices.length > 0 ? `admitted ${admitted} · rejected ${rejected}` : '',
			ticks: []
		},
		{
			// spec §2 rule 5 honesty: a run with no fill attempt (no key /
			// no model) reports skipped, never a fabricated completion;
			// with an attempt the counter is real progress or a real tally.
			id: 'descriptions',
			label: LABELS.descriptions,
			status: descStatus,
			counter: descCounter,
			ticks: []
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
