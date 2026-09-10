/**
 * Card assembly, facets, and cohort line (issue #28, spec §2/§3).
 * Deterministic descriptions — one card per root product, facets computed
 * from i-tag prefixes, cohort line counts over the fetched set. AI writes
 * title/snippet text via fillCards, zod-gated, fallback per spec §2 (no
 * fabrication, no invented metrics, no "archived" status — that status does
 * not exist in the protocol).
 */

import type { NostrEvent } from 'nostr-tools/core';
import type { GraphView } from '$lib/fabric';
import { indexerFilter, searchFilter, fullScanFilter, tTags, tagValues } from '$lib/fabric';
import type { NostrEvent as FabricEvent } from '$lib/fabric';
import type { ProviderOverrideInput } from '$lib/ai/provider';
import { getInterpretation, saveInterpretation } from '$lib/db';
import { generateStructured, type AIKind, type CallLLM } from '$lib/ai/output';
import { z } from 'zod';

export interface ProductCard {
	id: string;
	/** The event's type tag — the rule-5 fallback line names it (spec §2 rule 5). */
	typeTag: string;
	/** Root event's created_at — BIBLE J2 footer clock ("2w ago"; §2 rule 2). */
	createdAt: number;
	/** Root product event's author — the publisher chip (kind-0) renders from it. */
	pubkey: string;
	title: string;
	snippet?: string;
	identifiers: string[];
	retracted: boolean;
	boundMetadata: number;
	/** Bound metadata carrying an http(s) link (report/PDF artifacts; spec §9). */
	files: number;
	updates: number;
	contentStart: string;
	interpreted: boolean;
}

/* ------------------------------------------------------------------ *
 * Deterministic assembly
 * ------------------------------------------------------------------ */

function deriveFallbackTitle(event: NostrEvent): string {
	const identifiers = tagValues(event, 'i');
	if (identifiers.length > 0) return identifiers[0];
	const head = event.content.trim().split(/\s+/).slice(0, 5).join(' ');
	return head || event.id;
}

export function assembleCards(graph: GraphView, patchSources: NostrEvent[] = []): ProductCard[] {
	// One card per root PRODUCT (spec §3) — metadata nodes are bound records,
	// not cards; a metadata node mapped here would inflate the cohort counts.
	return graph.nodes
		.filter((node) => node.type === 'product')
		.map((node) => {
		const ev = node.event;
		const identifiers = [...new Set(tagValues(ev, 'i'))];
		const boundEdges = graph.edges.filter((e) => e.target === node.id && e.source !== node.id);
		const files = boundEdges.filter((edge) => {
			const src = graph.nodes.find((n) => n.id === edge.source);
			return src !== undefined && /https?:\/\//.test(src.event.content);
		}).length;
		const updates = patchSources.filter((p) => {
			const eTags = tagValues(p, 'e');
			return eTags.includes(node.id) && tTags(p).includes('scrutiny-patch');
		});
		return {
			id: node.id,
			typeTag: node.type === 'product' ? 'scrutiny-product' : 'scrutiny-metadata',
			createdAt: ev.created_at,
			pubkey: ev.pubkey,
			title: deriveFallbackTitle(ev),
			snippet: ev.content.slice(0, 200).trim() || undefined,
			identifiers,
			retracted: node.retracted,
			boundMetadata: boundEdges.length,
			files,
			updates: updates.length,
			contentStart: ev.content.slice(0, 200),
			interpreted: false
		};
	});
}

/* ------------------------------------------------------------------ *
 * Facets — computed deterministically from fetched events' tags (spec §3)
 * ------------------------------------------------------------------ */

export interface FacetGroup {
	prefix: string;
	values: Array<{ value: string; count: number }>;
}

export function computeFacets(events: NostrEvent[]): FacetGroup[] {
	const groups = new Map<string, Map<string, number>>();
	for (const event of events) {
		for (const tag of tagValues(event, 'i')) {
			const colonIdx = tag.indexOf(':');
			if (colonIdx === -1) continue;
			const prefix = tag.slice(0, colonIdx).toLowerCase();
			const value = tag.slice(colonIdx + 1);
			if (!groups.has(prefix)) groups.set(prefix, new Map());
			const map = groups.get(prefix)!;
			map.set(value, (map.get(value) ?? 0) + 1);
		}
	}
	return [...groups.entries()].map(([prefix, values]) => ({
		prefix,
		values: [...values.entries()]
			.map(([value, count]) => ({ value, count }))
			.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
	}));
}

export function applyFacets(events: NostrEvent[], selections: Record<string, Set<string>>): NostrEvent[] {
	const active = Object.entries(selections).filter(([, set]) => set.size > 0);
	if (active.length === 0) return events;
	return events.filter((event) => {
		const eventTags = new Set(tagValues(event, 'i'));
		for (const [prefix, selected] of active) {
			const eventValues = new Set(
				[...eventTags].filter((t) => t.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)).map((t) => t.slice(prefix.length + 1))
			);
			if (![...selected].some((v) => eventValues.has(v))) return false;
		}
		return true;
	});
}

/* ------------------------------------------------------------------ *
 * Cohort line (spec §3, owner ruling 2026-09-03: by event type —
 * "8 products · 8 metadata", no vendors/retracted counts)
 * ------------------------------------------------------------------ */

export function cohortLine(cards: ProductCard[], events: NostrEvent[] = []): string {
	const products = cards.length;
	const metadata = events.filter((event) => tTags(event).includes('scrutiny-metadata')).length;
	return `${products} product${products === 1 ? '' : 's'} · ${metadata} metadata`;
}

/* ------------------------------------------------------------------ *
 * Interpretation fill (spec §2 rules 4/5, cache at eventId+model, spec §6)
 * ------------------------------------------------------------------ */

const FillDraft = z.object({
	id: z.string().min(1),
	title: z.string().min(1).max(120),
	snippet: z.string().min(1).max(300)
});
const FillSchema = z.array(FillDraft);

const INSTRUCTIONS = [
	'You are a security-asset interpretation card writer.',
	'For each event, produce a concise title (≤120 chars) and snippet (≤300 chars).',
	'The `id` you output maps your answer back to the event — emit EXACTLY the id you were given.',
	'Use only facts from the provided content — never invent data, never emit a title about another event.',
	'Output a JSON array of {id, title, snippet} objects, no prose.'
].join('\n');

export interface FillCardsOptions {
	provider: ProviderOverrideInput;
	callLLM: CallLLM;
	signal?: AbortSignal;
	/** Reports the settle-kind when the fill call fails (unreachable/timeout →
	 * transport; schema_failure → the endpoint answered but output didn't
	 * conform). Lets the UI state the truth instead of guessing from
	 * interpreted===0 (spec §2 never-lie on the AI lane). */
	onFailure?: (kind: AIKind) => void;
}

const CLIP_LIMIT = { title: 120, snippet: 300 };

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export async function fillCards(cards: ProductCard[], opts: FillCardsOptions): Promise<ProductCard[]> {
	if (cards.length === 0) return [];
	const model = opts.provider.model?.trim();
	if (!model) return cards;

	// Cached interpretations first — never re-pay the LLM for a card we
	// already asked the same model about (spec §6, (eventId, model)).
	const cached = await Promise.all(
		cards.map(async (card) => {
			const hit = await getInterpretation(card.id, model);
			if (!hit?.bySurface.card) return null;
			const typed = hit.bySurface.card as Record<string, unknown>;
			if (typeof typed.title !== 'string' || typeof typed.snippet !== 'string') return null;
			return {
				...card,
				title: typed.title.slice(0, CLIP_LIMIT.title),
				snippet: typed.snippet.slice(0, CLIP_LIMIT.snippet),
				interpreted: true
			};
		})
	);
	const fresh = cards.filter((c, i) => cached[i] === null);
	if (fresh.length === 0) {
		return cached.map((c, i) => c ?? cards[i]);
	}

	// One batch-shaped call for all uncached cards — rate-limit-safe (spec §7's
	// AI-fill budget) and the draft's id binds every answer back to its card.
	const result = await generateStructured({
		schema: FillSchema,
		system: INSTRUCTIONS,
		messages: [
			{
				role: 'user',
				content: JSON.stringify(
					fresh.map((c) => ({ id: c.id, content: c.contentStart }))
				)
			}
		],
		provider: opts.provider,
		callLLM: opts.callLLM,
		abortSignal: opts.signal,
		temperature: 0.2
	});

	const drafts = new Map<string, { id: string; title: string; snippet: string }>();
	if (result.ok) {
		for (const draft of result.result) drafts.set(draft.id, draft);
	} else {
		// Never-lie: surface WHY the fill failed so the banner distinguishes a
		// dead endpoint (unreachable/timeout) from one that answered but whose
		// output didn't conform (schema_failure).
		opts.onFailure?.(result.kind);
	}

	return cards.map((card, i) => {
		if (cached[i]) return cached[i];
		const draft = drafts.get(card.id);
		if (!draft || !result.ok) return card; // rule 5 fallback per item
		const filled = {
			...card,
			title: clip(draft.title, CLIP_LIMIT.title),
			snippet: clip(draft.snippet, CLIP_LIMIT.snippet),
			interpreted: true
		};
		// Persist for repeat queries — same (eventId, model) surface (spec §6).
		void saveInterpretation(card.id, model, 'card', { title: filled.title, snippet: filled.snippet });
		return filled;
	});
}