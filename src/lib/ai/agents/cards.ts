/**
 * W4 · Cards agent — LLM-assisted card interpretation for SCRUTINY Lens.
 *
 * Each input graph is turned into a CardVM. LLM output is best-effort: the
 * deterministic tag projection (identifiers, status, metaSegments, stats)
 * is always authoritative, and the LLM draft only refines title/vendor/
 * typeToken/category/snippet/reasons. Per-item failures degrade to a
 * projectSkeleton-style CardVM and are recorded in dead_letter — the batch
 * never fails because one item was bad. Only a whole-page LLM/schema
 * failure surfaces as an error result.
 *
 * Offline-testable: `callLLM` is injectable and rejected artifacts land in an in-memory dead-letter ring (Persistent store: issue #12).
 */

import { z } from 'zod';
import {
	generateStructured,
	type AIResult,
	type AIKind,
	type CallLLM
} from '../output';
import { writeDeadLetter } from '../deadLetter';
import {
	projectSkeleton,
	tagValues,
	type SkeletonStats
} from '../projector';
import { buildSystemPrompt, DEFAULT_PROFILE } from '../prompts/vocabCcd';
import type { NostrEvent } from '../../fabric';

export const BATCH_SIZE = 12;

export const CARD_ENTITY_TYPE = 'card';
export const SCHEMA_VERSION = 'cardvm/1.0';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** 18 IconTokens (view-models.md §2; includes `corpus`). */
export const ICON_TOKENS = [
	'certificate',
	'vulnerability',
	'report',
	'target',
	'maintenance',
	'patch',
	'smartcard',
	'biometric',
	'network-device',
	'software',
	'hsm',
	'tpm',
	'scheme',
	'vendor',
	'document',
	'corpus',
	'generic',
	'unknown'
] as const;
export type IconToken = (typeof ICON_TOKENS)[number];
export const IconTokenEnum = z.enum(ICON_TOKENS);

export type CardStatus = 'active' | 'archived' | 'retracted' | 'unknown';
export type MatchBand = 'high' | 'medium' | 'low';

export interface Snippet {
	text: string;
	highlights?: Array<{ start: number; len: number }>;
}
export interface SnippetResult {
	ok: boolean;
	rule?: string;
	snippet?: Snippet;
}

/** Per-item dead-letter context. */
export interface DeadLetterCtx {
	entityId: string;
	profile: string;
	model: string;
}

/** Deterministic per-graph inputs handed to the LLM draft. */
export interface DeterministicInput extends DeadLetterCtx {
	identifiers: string[];
	status: string;
	facets: Record<string, string[]>;
}

export type CardVM = z.infer<typeof CardVMSchema>;

const highlightSchema = z.object({ start: z.number().int(), len: z.number().int() });
const snippetSchema = z.object({
	text: z.string(),
	highlights: z.array(highlightSchema).optional()
});
const facetsSchema = z.record(z.string(), z.array(z.string()));

export const CardVMSchema = z.object({
	entityId: z.string().min(1),
	title: z.string().min(1),
	vendor: z.string().max(80).optional(),
	typeToken: IconTokenEnum,
	category: z.string().max(160).optional(),
	identifiers: z.array(z.string().min(1)).min(1).max(2),
	scheme: z.string().max(60).optional(),
	assurance: z.string().regex(/^EAL[1-7]\+?$/).optional(),
	status: z.enum(['active', 'archived', 'retracted', 'unknown']),
	metaSegments: z.array(z.string()),
	matchBand: z.enum(['high', 'medium', 'low']),
	matchReasons: z.array(z.string().max(120)).max(3),
	snippet: snippetSchema,
	match: z.number().min(0).max(1),
	stats: z.object({
		boundMetadata: z.number().int().nonnegative(),
		attachments: z.number().int().nonnegative(),
		updates: z.number().int().nonnegative()
	}),
	facets: facetsSchema.optional(),
	groupKey: z.string().max(80).optional()
});

/**
 * Lenient page-level schema passed to generateStructured. Everything is
 * optional/passthrough so one malformed item never fails the whole array
 * gate; strict per-item validation happens in finalizeCard via
 * CardVMSchema.safeParse.
 */
const CardDraft = z
	.object({
		title: z.string().optional(),
		vendor: z.string().optional(),
		typeToken: z.string().optional(),
		category: z.string().optional(),
		scheme: z.string().optional(),
		match: z.number().optional(),
		matchReasons: z.array(z.string()).optional(),
		snippet: z
			.object({ text: z.string().optional(), highlights: z.array(highlightSchema).optional() })
			.optional()
	})
	.passthrough();
type CardDraft = z.infer<typeof CardDraft>;
const cardsPageSchema = z.object({ cards: z.array(CardDraft) });

/** Input graph for a single card. */
export interface CardGraph {
	entityId: string;
	event: NostrEvent;
	neighbors: NostrEvent[];
	stats: {
		boundMetadata: number;
		attachments: number;
		updates: number;
	};
}

export interface InterpretCardsOptions {
	graphs: CardGraph[];
	query: string;
	profile?: string;
	provider?: { baseUrl?: string; model?: string; apiKey?: string };
	/** Test seam for offline tests. */
	callLLM?: CallLLM;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set(['the', 'a', 'of', 'in', 'for', 'and', 'is', 'to']);

const IDENTIFIER_KEYS = ['ccid', 'cve', 'cpe', 'cwe', 'pp', 'd'] as const;
const EAL = /^EAL[1-7]\+?$/;
const BANNED_OPENERS = ['this event', 'this document', 'in this data', 'the event is', 'it is'];

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function queryTerms(query: string): string[] {
	return normalize(query)
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

function deriveStatus(event: NostrEvent): CardStatus {
	const ctx = [...tagValues(event, 'status'), ...tagValues(event, 'lifecycle')].join(' ').toLowerCase();
	if (/retract/.test(ctx)) return 'retracted';
	if (/archiv/.test(ctx)) return 'archived';
	if (/activ/.test(ctx)) return 'active';
	return 'unknown';
}

function statusLabel(status: CardStatus): string | undefined {
	if (status === 'active') return 'Active';
	if (status === 'archived') return 'Archived';
	if (status === 'retracted') return 'Retracted';
	return undefined;
}

/** Dice coefficient over lowercase character bigrams (whitespace-collapsed). */
function bigramSimilarity(a: string, b: string): number {
	const normA = normalize(a);
	const normB = normalize(b);
	if (normA === normB) return 1;
	if (normA.length < 2 || normB.length < 2) return 0;
	const grams = (s: string): Set<string> => {
		const set = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
		return set;
	};
	const ga = grams(normA);
	const gb = grams(normB);
	let inter = 0;
	for (const g of ga) if (gb.has(g)) inter++;
	return (2 * inter) / (ga.size + gb.size);
}

function bandSort(band: MatchBand): number {
	return band === 'high' ? 0.9 : band === 'medium' ? 0.6 : 0.35;
}

function clamp01(n: unknown): number | undefined {
	if (typeof n === 'number' && Number.isFinite(n)) return Math.min(1, Math.max(0, n));
	return undefined;
}

/* ------------------------------------------------------------------ *
 * 1. metaSegments — fixed order, missing segments drop without dangling seps
 * ------------------------------------------------------------------ */

export function metaSegmentsRule(fields: {
	scheme?: string;
	assurance?: string;
	status?: string;
}): string[] {
	const segments: string[] = [];
	if (fields.scheme && fields.scheme.trim().length > 0) segments.push(fields.scheme.trim());
	if (fields.assurance && EAL.test(fields.assurance)) segments.push(fields.assurance);
	if (fields.status && fields.status.trim().length > 0) {
		const s = fields.status.trim();
		const titled = /^active$/i.test(s)
			? 'Active'
			: /^archived$/i.test(s)
				? 'Archived'
				: /^retracted$/i.test(s)
					? 'Retracted'
					: s;
		segments.push(titled);
	}
	return segments;
}

/* ------------------------------------------------------------------ *
 * 2. matchBand — identifier hit / coverage / facet-overlap thresholds
 * ------------------------------------------------------------------ */

export function matchBandRule(
	query: string,
	identifiers: string[],
	facets?: Record<string, string[]>
): MatchBand {
	const terms = queryTerms(query);
	if (terms.length === 0) return 'low';

	// Identifier hit: any query term is contained in (or equals) an identifier.
	const idHit = identifiers.some((id) => {
		const nid = normalize(id);
		return terms.some((t) => nid.includes(t));
	});

	// Facet overlaps: a facet key or value contains a query term.
	const facetValues: string[] = [];
	for (const key of Object.keys(facets ?? {})) {
		facetValues.push(key, ...(facets?.[key] ?? []));
	}
	const facetHits = facetValues.filter((v) => terms.some((t) => normalize(v).includes(t)));
	const facetOverlaps = new Set(
		facetValues
			.filter((v) => terms.some((t) => normalize(v).includes(t)))
			.map((v) => normalize(v))
	).size;

	// Corpus coverage: fraction of distinct terms appearing in identifiers/facets.
	const corpus = dedupe([
		...identifiers.map((i) => normalize(i)),
		...facetValues.map((v) => normalize(v))
	]).join(' ');
	const covered = terms.filter((t) => corpus.includes(t)).length;
	const coverage = terms.length > 0 ? covered / terms.length : 0;

	if (idHit) return 'high';
	if (coverage >= 1 && facetHits.length >= 1) return 'high';
	if (coverage >= 0.6 || facetOverlaps >= 2) return 'medium';
	return 'low';
}

/* ------------------------------------------------------------------ *
 * 3. validateMatchReasons — drop invented reasons + dead-letter them
 * ------------------------------------------------------------------ */

export function validateMatchReasons(
	reasons: unknown[] | undefined,
	input: DeterministicInput
): string[] {
	const out: string[] = [];
	for (const r of reasons ?? []) {
		if (typeof r !== 'string' || r.trim().length === 0) continue;
		const reason = r.trim();
		if (rebinds(reason, input)) out.push(reason);
		else {
			writeDeadLetter({
				entityType: CARD_ENTITY_TYPE,
				entityId: input.entityId,
				schemaVersion: SCHEMA_VERSION,
				profile: input.profile,
				model: input.model,
				payload: { reason },
				reason: `unverifiable match reason: ${reason}`
			});
		}
	}
	return out.slice(0, 3);
}

function rebinds(reason: string, input: DeterministicInput): boolean {
	// "identifier: X" must match one of the identifiers.
	const idm = /^identifier[\s:]+(.+)$/i.exec(reason);
	if (idm) {
		const val = normalize(idm[1]);
		return input.identifiers.some((i) => normalize(i).includes(val) || val.includes(normalize(i)));
	}
	// "status: Y" must match the derived status label.
	const stm = /^status[\s:]+(.+)$/i.exec(reason);
	if (stm) {
		const val = stm[1].trim().toLowerCase();
		const label = statusLabel(input.status as CardStatus)?.toLowerCase();
		return label === input.status.toLowerCase() || label === val || val === input.status.toLowerCase();
	}
	// "facet: Z / <key>: Z" must match a facet key or value.
	const fm = /^(facet|[a-z][a-z0-9-]*)[\s:]+(.+)$/i.exec(reason);
	if (fm) {
		const val = normalize(fm[2]);
		for (const key of Object.keys(input.facets)) {
			const vals = [...input.facets[key], key];
			if (vals.some((v) => normalize(v).includes(val) || val.includes(normalize(v)))) return true;
		}
		return false;
	}
	// Anything else is unverifiable — drop.
	return false;
}

/* ------------------------------------------------------------------ *
 * 4. snippetRules — R1..R8 quality contract
 * ------------------------------------------------------------------ */

export function snippetRules(
	text: string,
	query: string,
	highlights: Array<{ start: number; len: number }> | undefined,
	metaStrings: string[]
): SnippetResult {
	// R1 — every query term appears (stopwords exempt).
	const terms = queryTerms(query);
	const norm = normalize(text);
	if (terms.length > 0 && terms.some((t) => !norm.includes(t))) return bad('R1');

	if (text.length > 0 && terms.length > 0) {
		// R2 — entity name or an identifier in the first 12 words.
		const first12 = text.split(/\s+/).slice(0, 12).join(' ').toLowerCase();
		if (!terms.some((t) => first12.includes(t))) return bad('R2');
	}

	// R3 — not the event's (deterministic meta) lead sentence (>0.85 similarity).
	const reference = metaStrings.join(' ');
	if (reference.length > 0 && bigramSimilarity(text, reference) > 0.85) return bad('R3');

	// R5 — ≤2 highlight spans covering query terms only.
	if (highlights && highlights.length > 2) return bad('R5');
	if (highlights && highlights.length > 0 && terms.length > 0) {
		for (const h of highlights) {
			const span = norm.slice(h.start, h.start + h.len);
			if (!terms.some((t) => span.includes(t))) return bad('R5');
		}
	}

	// R6 — ≤300 chars, no mid-word cut.
	if (text.length > 300) return bad('R6');

	// R7 — banned openers.
	const lower = text.toLowerCase();
	const trimmedStart = lower.trimStart();
	if (BANNED_OPENERS.some((o) => trimmedStart.startsWith(o))) return bad('R7');

	// R8 — no substring ≥12 chars shared with any metaSegments string.
	for (const meta of metaStrings) {
		if (meta.length < 12) continue;
		for (let i = 0; i + 12 <= text.length; i++) {
			const sub = text.slice(i, i + 12);
			if (meta.includes(sub)) return bad('R8');
		}
	}

	return { ok: true, snippet: { text, highlights: highlights ?? [] } };
}

function bad(rule: string): SnippetResult {
	return { ok: false, rule };
}

/* ------------------------------------------------------------------ *
 * Finalization
 * ------------------------------------------------------------------ */

function buildDeterministic(graph: CardGraph) {
	const event = graph.event;
	const status = deriveStatus(event);
	const identifiers = dedupe([
		...tagValues(event, 'identifier'),
		...IDENTIFIER_KEYS.flatMap((k) => tagValues(event, k))
	])
		.filter((v) => v.length > 0)
		.slice(0, 2);
	const scheme = tagValues(event, 'scheme')[0] ?? undefined;
	const assurance = tagValues(event, 'eal').find((v) => EAL.test(v)) ?? undefined;
	const statusLabel_ = statusLabel(status);
	const metaSegments = metaSegmentsRule({ scheme, assurance, status: statusLabel_ });
	const facets: Record<string, string[]> = {};
	if (scheme) facets.scheme = [scheme];
	if (assurance) facets.assurance = [assurance];
	if (statusLabel_) facets.status = [statusLabel_];
	return { identifiers, status, metaSegments, facets, scheme, assurance };
}

function emptySnippet(): Snippet {
	return { text: '', highlights: [] };
}

function degradedCard(graph: CardGraph, query: string, ctx: DeadLetterCtx): CardVM {
	const p = projectSkeleton(graph.event, graph.stats);
	const det = buildDeterministic(graph);
	return {
		entityId: graph.entityId,
		title: p.title,
		typeToken: 'unknown',
		identifiers: p.identifiers.length > 0 ? p.identifiers : det.identifiers,
		status: det.status,
		metaSegments: det.metaSegments,
		matchBand: matchBandRule(query, p.identifiers, det.facets),
		matchReasons: [],
		snippet: emptySnippet(),
		match: 0,
		stats: { ...graph.stats },
		facets: det.facets
	};
}

function finalizeCard(
	graph: CardGraph,
	query: string,
	draft: CardDraft | undefined,
	ctx: DeadLetterCtx
): CardVM {
	const det = buildDeterministic(graph);
	const candidates = det.identifiers.length > 0 ? det.identifiers : [bestFallbackId(graph)];
	// Match reasons — invented ones are dropped + dead-lettered.
	const reasonInput: DeterministicInput = { ...ctx, identifiers: candidates, status: det.status, facets: det.facets };
	const matchReasons = validateMatchReasons(draft?.matchReasons ?? [], reasonInput);
	const matchBand = matchBandRule(query, candidates, det.facets);

	// Snippet quality gate (rules fire against deterministic meta line).
	let snippet: Snippet = emptySnippet();
	if (draft?.snippet?.text !== undefined && draft.snippet.text.trim().length > 0) {
		const sr = snippetRules(
			draft.snippet.text,
			query,
			draft.snippet.highlights ?? [],
			det.metaSegments
		);
		if (sr.ok && sr.snippet) {
			snippet = sr.snippet;
		} else if (!sr.ok) {
			writeDeadLetter({
				entityType: CARD_ENTITY_TYPE,
				entityId: ctx.entityId,
				schemaVersion: SCHEMA_VERSION,
				profile: ctx.profile,
				model: ctx.model,
				payload: { text: draft.snippet.text, highlights: draft.snippet.highlights },
				reason: `snippet ${sr.rule}`
			});
		}
	}

	const candidate = {
		entityId: graph.entityId,
		title: typeof draft?.title === 'string' && draft.title.trim().length > 0 ? draft.title : '',
		vendor: typeof draft?.vendor === 'string' && draft.vendor.trim().length > 0 ? draft.vendor : undefined,
		typeToken: typeof draft?.typeToken === 'string' && draft.typeToken.length > 0 ? draft.typeToken : 'unknown',
		category: typeof draft?.category === 'string' && draft.category.trim().length > 0 ? draft.category : undefined,
		identifiers: candidates,
		scheme: typeof draft?.scheme === 'string' && draft.scheme.trim().length > 0 ? draft.scheme : det.scheme,
		assurance: det.assurance,
		status: det.status,
		metaSegments: det.metaSegments,
		matchBand,
		matchReasons,
		snippet,
		match: clamp01(draft?.match ?? NaN) ?? bandSort(matchBand),
		stats: { ...graph.stats },
		facets: det.facets
	};

	const parsed = CardVMSchema.safeParse(candidate);
	if (parsed.success) return parsed.data;

	// Per-item failure → degrade this card, keep the batch.
	const reason = parsed.error.issues
		.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
		.join('; ');
	writeDeadLetter({
		entityType: CARD_ENTITY_TYPE,
		entityId: ctx.entityId,
		schemaVersion: SCHEMA_VERSION,
		profile: ctx.profile,
		model: ctx.model,
		payload: candidate,
		reason: `card validation failed: ${reason}`
	});
	return degradedCard(graph, query, ctx);
}

function bestFallbackId(graph: CardGraph): string {
	return graph.event.content.trim().split(/\s+/)[0] || graph.entityId;
}

/* ------------------------------------------------------------------ *
 * interpretCards — batch pipeline
 * ------------------------------------------------------------------ */

function mapKind(kind: AIKind): AIKind {
	// Task contract: unreachable/timeout both surface as 'unreachable'.
	if (kind === 'timeout') return 'unreachable';
	return kind;
}

export async function interpretCards(
	opts: InterpretCardsOptions
): Promise<AIResult<{ cards: CardVM[] }>> {
	const graphs = opts.graphs;
	const query = opts.query;
	const profile = opts.profile ?? DEFAULT_PROFILE;
	const model = opts.provider?.model ?? 'unspecified';
	const system = buildSystemPrompt({ profile });

	const cards: CardVM[] = [];
	// Pages of BATCH_SIZE (test-overridable via BATCH_SIZE const).
	for (let i = 0; i < graphs.length; i += BATCH_SIZE) {
		const page = graphs.slice(i, i + BATCH_SIZE);
		const payload = JSON.stringify({ query, graphs: page });
		const res = await generateStructured({
			schema: cardsPageSchema,
			system,
			messages: [
				{
					role: 'user',
					content: `Interpret each graph into one summary card, in the same order as the input.\n${payload}\n\nRespond with JSON only, no prose. Return an object {"cards":[ ... one object per graph, in order ... ]}.`
				}
			],
			provider: opts.provider,
			callLLM: opts.callLLM
		});

		if (!res.ok) {
			if (res.kind === 'schema_failure') {
				return { ok: false, kind: 'schema_failure', message: res.message };
			}
			const kind = mapKind(res.kind);
			return { ok: false, kind, message: res.message };
		}

		const drafts = res.result.cards;
		for (let j = 0; j < page.length; j++) {
			const ctx: DeadLetterCtx = {
				entityId: page[j].entityId,
				profile,
				model
			};
			cards.push(finalizeCard(page[j], query, drafts[j], ctx));
		}
	}

	return { ok: true, result: { cards } };
}
