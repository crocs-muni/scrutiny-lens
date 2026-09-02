/**
 * Query translation (issue #28, spec §1/§3): identifiers route DIRECTLY to
 * tag searches, never through AI; prose goes through one zod-gated AI call
 * (≤3 searches, prefixes open per IR-4); no key / AI-down → one free-text
 * search, never nothing.
 */

import { z } from 'zod';
import type { CallLLM, AIResult } from '$lib/ai/output';
import { generateStructured } from '$lib/ai/output';
import type { ProviderOverrideInput } from '$lib/ai/provider';

export type SearchRequest = { kind: 'tag' | 'text'; value: string; source: 'identifier' | 'ai' | 'fallback' };
export type SearchPlan = { searches: SearchRequest[] };

/** Indexer prefixes AI is GUIDED toward (protocol passes unknown through opaque — spec §3). */
export const GUIDED_PREFIXES = [
	'cve',
	'cwe',
	'cpe',
	'purl',
	'cc',
	'fips',
	'fcc-id',
	'swid',
	'gtin',
	'pp',
	'vendor',
	'scheme',
	'cc-cert-id',
	'cc-scheme'
] as const;

/* ------------------------------------------------------------------ *
 * Deterministic: identifier detection (spec §2 rule 2 — never AI)
 * ------------------------------------------------------------------ */

// Bare CVE / GHSA tokens in prose (per spec §1 these route directly to tag
// searches; typed prefix:value tokens do too, opaquely per IR-4).
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const GHSA_RE = /\bGHSA(?:-[A-Za-z0-9]{4}){3}\b/gi;
const PURL_RE = /\bpkg:[A-Za-z0-9+._/-]+@[^\s,;"'<>]+/gi;
const PREFIX_VALUE_RE = /\b[A-Za-z0-9-]+:[^\s,;"'<>]+/g;

export function detectIdentifiers(question: string): string[] {
	const out = new Set<string>();
	for (const m of question.matchAll(CVE_RE)) out.add(`cve:${m[0].replace(/cve/i, 'CVE')}`);
	for (const m of question.matchAll(GHSA_RE)) out.add(`ghsa:${m[0].replace(/ghsa/i, 'GHSA')}`);
	const purls = new Set<string>([...question.matchAll(PURL_RE)].map((m) => m[0]));
	for (const purl of purls) out.add(`purl:${purl}`);
	for (const m of question.matchAll(PREFIX_VALUE_RE)) {
		// pkg: tokens are already countable as purls; skip duplicates.
		if (!purls.has(m[0])) out.add(m[0]);
	}
	return [...out];
}

/** The shared prefix:value grammar used for validation (never rejecting an
 * unknown prefix — IR-4's pass-through guarantee). */
const TAG_VALUE = /^[a-z0-9-]+:\S+$/i;

// eslint-disable-next-line no-unused-vars
const isTag = (v: string): boolean => TAG_VALUE.test(v);

/* ------------------------------------------------------------------ *
 * LLM plan (one call, ≤3, guided toward the guided prefixes — spec §5)
 * ------------------------------------------------------------------ */

const SearchDraft = z.object({
	kind: z.enum(['tag', 'text']),
	value: z.string().min(1).max(300)
});
const SearchPlanSchema = z.array(SearchDraft).min(1).max(3);

const INSTRUCTIONS = [
	'Turn the user question into searches for a nostr security-asset intelligence relay.',
	'Emit ≤3 searches, prefix:value or free text, guided toward these prefixes when plausible:',
	GUIDED_PREFIXES.join(', '),
	'Do not interpret interrogative wrapper language (a "still certified" clause becomes a post-filter, not a search).',
	'No other prose.'
].join('\n');

export interface TranslateOptions {
	question: string;
	provider?: ProviderOverrideInput;
	callLLM: CallLLM;
	signal?: AbortSignal;
	profile?: string;
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

async function translateViaAi(reminder: string, opts: TranslateOptions): Promise<SearchRequest[]> {
	if (!opts.provider) return [];
	const result = await generateStructured({
		schema: SearchPlanSchema,
		system: INSTRUCTIONS,
		messages: [{ role: 'user', content: reminder }],
		provider: opts.provider,
		callLLM: opts.callLLM,
		abortSignal: opts.signal,
		temperature: 0.2
	});
	if (!result.ok) return [];
	return result.result.flatMap((draft) => {
		const value = draft.value.trim();
		if (value === '') return [];
		if (draft.kind === 'tag') {
			return TAG_VALUE.test(value) ? [{ kind: 'tag', value: clip(value, 120), source: 'ai' } as SearchRequest] : [];
		}
		return [{ kind: 'text', value: clip(value, 120), source: 'ai' } as SearchRequest];
	});
}

/* ------------------------------------------------------------------ *
 * translateQuestion (deterministic ordering: identifiers → AI → fallback)
 * ------------------------------------------------------------------ */

export async function translateQuestion(opts: TranslateOptions): Promise<AIResult<SearchPlan>> {
	const question = opts.question.trim();
	if (question === '') return { ok: true, result: { searches: [] } };

	const identifiers = detectIdentifiers(question)
		.map((v) => v.trim())
		.filter((v) => v !== '');

	// When the whole question is identifiers, no AI call at all (spec §1).
	const prose = question
		.split(/\s+/)
		.filter((tok) => !identifiers.some((id) => id.startsWith(tok.split(':')[0] + ':') || tok === id))
		.join(' ')
		.trim();

	const proseRemaining = prose !== '' && prose !== question && identifiers.length > 0 ? prose : (identifiers.length === 0 ? question : '');

	if (identifiers.length > 0 && (proseRemaining === '' || proseRemaining.split(/\s+/).every((tok) => identifiers.some((id) => id.includes(tok))))) {
		return {
			ok: true,
			result: {
				searches: identifiers.map((value) => ({
					kind: 'tag',
					value,
					source: 'identifier'
				}))
			}
		};
	}

	let aiSearches: SearchRequest[] = [];
	let fallbackUsed = false;
	if (proseRemaining !== '') {
		aiSearches = await translateViaAi(proseRemaining, opts);
		if (aiSearches.length === 0) {
			fallbackUsed = true;
		}
	}

	// Total ≤3 (spec §3): identifiers take priority over AI-planned searches.
	const capped = [
		...identifiers.map((value) => ({ kind: 'tag' as const, value, source: 'identifier' as const })),
		...aiSearches
	].slice(0, 3);

	if (fallbackUsed && capped.length === 0) {
		return {
			ok: true,
			result: { searches: [{ kind: 'text', value: clip(question, 300), source: 'fallback' }] }
		};
	}

	return { ok: true, result: { searches: capped } };
}
