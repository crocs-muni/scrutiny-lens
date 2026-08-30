/**
 * W4 · Query agent — free-text query → interpretation + relay filter plan.
 *
 * The LLM only proposes the FILTER PLAN, as a bare JSON array (the "plain-text
 * JSON-array workaround": small models emit a flat array far more reliably than
 * a nested wrapper object; the boundary zod-gates it anyway). Everything else
 * in the returned interpretation — steps, interpretation/summary text, and the
 * queryType classification — is derived deterministically from the validated
 * plan, so the UI narration can never drift from the filters that will run.
 *
 * Validation contract (J1 AC7): identifier filters whose `prefix:value` prefix
 * is not in KNOWN_INDEXER_PREFIXES are rejected with a reason; the rejection is
 * visible as an InterpretingStep. An empty post-validation plan degrades to a
 * single free-text filter over the raw query — the batch never returns nothing
 * to search.
 */

import { z } from 'zod';
import {
	generateStructured,
	type AIResult,
	type AIKind,
	type CallLLM
} from '../output';
import { buildSystemPrompt, DEFAULT_PROFILE } from '../prompts/vocabCcd';

/** Indexer prefixes the query agent MAY emit (docs/types.md §Indexer prefixes). */
export const KNOWN_INDEXER_PREFIXES = ['cc', 'cve', 'cpe', 'cwe', 'vendor', 'pp'] as const;
const KNOWN_PREFIXES: readonly string[] = KNOWN_INDEXER_PREFIXES;

export type QueryType = 'identifier' | 'vulnerability' | 'certificate' | 'product' | 'base';

/** Query agent output filter (docs/types.md §Wire types). */
export interface SearchFilter {
	mode: 'browse' | 'identifier' | 'freetext';
	identifier?: string;
	search?: string;
	types?: string[];
}

/** InterpretingVM step (view-models.md §3.1). */
export interface InterpretingStep {
	kind: 'recognized' | 'queried' | 'widened' | 'traversing' | 'resolved';
	label: string;
	detail?: string;
	prefix?: string;
	value?: string;
}

export interface QueryInterpretation {
	filters: SearchFilter[];
	queryType: QueryType;
	interpretation: string;
	steps: InterpretingStep[];
	summary: string;
}

export interface InterpretQueryOptions {
	query: string;
	profile?: string;
	provider?: { name?: string; baseUrl?: string; model?: string; apiKey?: string };
	/** Test seam for offline tests. */
	callLLM?: CallLLM;
}

/* ------------------------------------------------------------------ *
 * LLM boundary schema — the bare filter array
 * ------------------------------------------------------------------ */

const FilterDraft = z.object({
	mode: z.enum(['browse', 'identifier', 'freetext']),
	identifier: z.string().min(1).optional(),
	search: z.string().min(1).optional(),
	types: z.array(z.string().min(1)).optional()
});
const FilterPlanSchema = z.array(FilterDraft).max(8);

const QUERY_PLAN_INSTRUCTIONS = [
	'You are the SCRUTINY Lens query interpreter. Turn the user query into a relay filter plan.',
	'',
	'Respond with a BARE JSON ARRAY of filter objects — no prose, no markdown fences, no wrapper object. Each filter is one of:',
	'- {"mode":"identifier","identifier":"<prefix>:<value>"} — when the query names a known identifier. Allowed prefixes ONLY: cc, cve, cpe, cwe, vendor, pp. Keep casing/values exactly as written (e.g. cve:CVE-2017-15361, cc:BSI-DSZ-CC-0814-2012, cpe:2.3:h:infineon:*).',
	'- {"mode":"freetext","search":"<terms>"} — for conceptual/product queries; keep the query’s salient terms (product names, vendors, attack names).',
	'- {"mode":"browse","types":["<prefix>"]} — when the user only wants to browse one category.',
	'',
	'You MAY combine identifier filters with one freetext filter for the remaining concepts. Identifiers first. Never invent a prefix outside the allowed list; leave unrecognized tokens to the freetext filter instead. Return an exact identifier only when it actually appears in the query.'
].join('\n');

/* ------------------------------------------------------------------ *
 * Deterministic: prefix validation
 * ------------------------------------------------------------------ */

const PREFIX_VALUE = /^([A-Za-z][A-Za-z0-9-]*):(\S+)$/;

interface Rejection {
	identifier: string;
	prefix: string;
	reason: string;
}

/**
 * Validate an LLM-proposed plan against KNOWN_INDEXER_PREFIXES. Unknown-prefix
 * identifier filters (e.g. `xyz:123`) are rejected with a reason; everything
 * well-formed survives, deduplicated.
 */
export function validatePlan(plan: SearchFilter[]): { filters: SearchFilter[]; rejections: Rejection[] } {
	const filters: SearchFilter[] = [];
	const rejections: Rejection[] = [];
	const seen = new Set<string>();

	for (const f of plan) {
		if (f.mode === 'identifier') {
			const id = (f.identifier ?? '').trim();
			const m = PREFIX_VALUE.exec(id);
			if (m) {
				const prefix = m[1].toLowerCase();
				if (!KNOWN_PREFIXES.includes(prefix)) {
					rejections.push({
						identifier: id,
						prefix,
						reason: `Unknown indexer prefix "${prefix}" (allowed: ${KNOWN_INDEXER_PREFIXES.join(', ')})`
					});
					continue;
				}
			}
			const filter: SearchFilter = { mode: 'identifier', identifier: id };
			const key = JSON.stringify(filter);
			if (!seen.has(key)) {
				seen.add(key);
				filters.push(filter);
			}
			continue;
		}
		const filter: SearchFilter = { mode: f.mode };
		if (f.search !== undefined) filter.search = f.search;
		if (f.types !== undefined) filter.types = f.types;
		const key = JSON.stringify(filter);
		if (!seen.has(key)) {
			seen.add(key);
			filters.push(filter);
		}
	}

	return { filters, rejections };
}

/* ------------------------------------------------------------------ *
 * Deterministic: queryType classification
 * ------------------------------------------------------------------ */

const IDENTIFIER_TOKEN = /\b(?:cc|cve|cpe|cwe|vendor|pp):[^\s,;]+/gi;

/**
 * Classify the query:
 * - exactly one `{prefix:value}` token and the whole query IS that token → 'identifier'
 * - mentions a CVE → 'vulnerability'
 * - mentions a certificate → 'certificate'
 * - a bare keyword (one word, nothing recognized) → 'base'
 * - otherwise → 'product'
 */
export function classifyQueryType(query: string): QueryType {
	const trimmed = query.trim();
	IDENTIFIER_TOKEN.lastIndex = 0;
	const matches = trimmed.match(IDENTIFIER_TOKEN) ?? [];
	if (matches.length === 1 && trimmed === matches[0]) return 'identifier';
	if (/cve/i.test(trimmed)) return 'vulnerability';
	if (/cert/i.test(trimmed)) return 'certificate';
	if (/^\S+$/.test(trimmed)) return 'base';
	return 'product';
}

/* ------------------------------------------------------------------ *
 * Deterministic: steps + narrative (view-models.md caps: label ≤120, summary ≤300)
 * ------------------------------------------------------------------ */

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function stepForFilter(f: SearchFilter, query: string): InterpretingStep {
	if (f.mode === 'identifier' && f.identifier) {
		const m = PREFIX_VALUE.exec(f.identifier);
		const label = m
			? `Recognized ${f.identifier} as ${m[1].toLowerCase()} identifier`
			: `Recognized ${f.identifier}`;
		const step: InterpretingStep = { kind: 'recognized', label: clip(label, 120) };
		if (m) {
			step.prefix = m[1].toLowerCase();
			step.value = m[2];
		} else {
			step.value = f.identifier;
		}
		return step;
	}
	if (f.mode === 'freetext') {
		const search = f.search ?? query;
		return { kind: 'queried', label: clip(`Free-text search for "${search}"`, 120) };
	}
	const types = f.types?.length ? ` (${f.types.join(', ')})` : '';
	return { kind: 'queried', label: clip(`Browsing catalog${types}`, 120) };
}

function finalize(query: string, plan: SearchFilter[]): QueryInterpretation {
	const { filters, rejections } = validatePlan(plan);

	// Empty post-validation plan → honest fallback: one free-text filter.
	if (filters.length === 0) {
		filters.push({ mode: 'freetext', search: query });
	}

	const steps: InterpretingStep[] = filters.map((f) => stepForFilter(f, query));
	for (const r of rejections) {
		steps.push({
			kind: 'resolved',
			label: clip(`Rejected ${r.identifier}: ${r.reason}`, 120),
			prefix: r.prefix,
			value: r.identifier
		});
	}

	const queryType = classifyQueryType(query);

	const recognized = filters.filter((f) => f.mode === 'identifier' && f.identifier);
	const free = filters.find((f) => f.mode === 'freetext');
	let interpretation: string;
	if (recognized.length > 0) {
		interpretation = `Recognized ${recognized.map((f) => f.identifier).join(', ')}`;
		if (free?.search) interpretation += `; searching "${free.search}"`;
	} else if (free?.search) {
		interpretation = `Searching "${free.search}"`;
	} else {
		interpretation = `Browsing catalog${filters[0].types?.length ? ` (${filters[0].types.join(', ')})` : ''}`;
	}

	const parts: string[] = [];
	for (const f of filters) {
		if (f.mode === 'identifier') parts.push(`identifier filter ${f.identifier}`);
		if (f.mode === 'freetext') parts.push(`free-text filter "${f.search ?? query}"`);
		if (f.mode === 'browse') parts.push(`browse filter${f.types?.length ? ` (${f.types.join(', ')})` : ''}`);
	}
	const rejectedNote =
		rejections.length > 0
			? ` Rejected ${rejections.length} unsupported-prefix filter(s): ${rejections.map((r) => r.identifier).join(', ')}.`
			: '';
	const summary = clip(`Query type: ${queryType}. Plan: ${parts.join('; ')}.${rejectedNote}`, 300);

	return { filters, queryType, interpretation, steps, summary };
}

/* ------------------------------------------------------------------ *
 * interpretQuery
 * ------------------------------------------------------------------ */

function mapKind(kind: AIKind): AIKind {
	// Task contract: unreachable/timeout both surface as 'unreachable'.
	if (kind === 'timeout') return 'unreachable';
	return kind;
}

export async function interpretQuery(
	opts: InterpretQueryOptions
): Promise<AIResult<QueryInterpretation>> {
	const query = opts.query.trim();
	const profile = opts.profile ?? DEFAULT_PROFILE;
	const system = buildSystemPrompt({ profile, extra: QUERY_PLAN_INSTRUCTIONS });

	const res = await generateStructured({
		schema: FilterPlanSchema,
		system,
		messages: [
			{
				role: 'user',
				content: `User query:\n${query}\n\nRespond with the bare JSON array of filters only.`
			}
		],
		provider: opts.provider,
		callLLM: opts.callLLM
	});

	if (!res.ok) {
		return { ok: false, kind: mapKind(res.kind), message: res.message };
	}

	return { ok: true, result: finalize(query, res.result) };
}
