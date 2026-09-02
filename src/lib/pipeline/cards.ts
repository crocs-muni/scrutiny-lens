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
import { generateStructured, type CallLLM } from '$lib/ai/output';
import { z } from 'zod';

export interface ProductCard {
	id: string;
	title: string;
	snippet?: string;
	identifiers: string[];
	retracted: boolean;
	boundMetadata: number;
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
	return graph.nodes.map((node) => {
		const ev = node.event;
		const identifiers = [...new Set(tagValues(ev, 'i'))];
		const boundEdges = graph.edges.filter((e) => e.target === node.id && e.source !== node.id);
		const updates = patchSources.filter((p) => {
			const eTags = tagValues(p, 'e');
			return eTags.includes(node.id) && tTags(p).includes('scrutiny-patch');
		});
		return {
			id: node.id,
			title: deriveFallbackTitle(ev),
			snippet: ev.content.slice(0, 200).trim() || undefined,
			identifiers,
			retracted: node.retracted,
			boundMetadata: boundEdges.length,
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
 * Cohort line (spec §3: "12 products · 4 vendors · 2 retracted")
 * ------------------------------------------------------------------ */

export function cohortLine(cards: ProductCard[], events: NostrEvent[] = []): string {
	const products = cards.length;
	const vendorSet = new Set<string>();
	for (const event of events) {
		for (const tag of tagValues(event, 'i')) {
			if (tag.toLowerCase().startsWith('vendor:')) vendorSet.add(tag);
		}
	}
	const vendors = vendorSet.size;
	const retracted = cards.filter((c) => c.retracted).length;
	return `${products} products · ${vendors} vendors · ${retracted} retracted`;
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
	'Use only facts from the provided content — never invent data.',
	'Output a JSON array of {id, title, snippet} objects, no prose.'
].join('\n');

export interface FillCardsOptions {
	provider: ProviderOverrideInput;
	callLLM: CallLLM;
	signal?: AbortSignal;
}

const CLIP_LIMIT = { title: 120, snippet: 300 };

function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

async function fillCard(card: ProductCard, opts: FillCardsOptions, model: string): Promise<ProductCard> {
	// Interpretations cache at (eventId, model) — spec §6: repeat queries
	// never re-pay the LLM round-trip.
	const cached = await getInterpretation(card.id, model);
	if (cached?.bySurface.card) {
		const typed = cached.bySurface.card as Record<string, unknown>;
		if (typeof typed.title === 'string' && typeof typed.snippet === 'string') {
			return {
				...card,
				title: typed.title.slice(0, CLIP_LIMIT.title),
				snippet: typed.snippet.slice(0, CLIP_LIMIT.snippet),
				interpreted: true
			};
		}
	}

	const result = await generateStructured({
		schema: FillSchema,
		system: INSTRUCTIONS,
		messages: [{ role: 'user', content: card.contentStart }],
		provider: opts.provider,
		callLLM: opts.callLLM,
		abortSignal: opts.signal,
		temperature: 0.2
	});

	if (!result.ok) return card; // rule 5 fallback stays visible-degraded
	if (result.result.length === 0) return card;

	const hit = result.result[0];
	const filled = {
		...card,
		title: clip(hit.title, CLIP_LIMIT.title),
		snippet: clip(hit.snippet, CLIP_LIMIT.snippet),
		interpreted: true
	};

	// Persist for repeat queries — same (eventId, model) key (spec §6).
	await saveInterpretation(card.id, model, 'card', { title: filled.title, snippet: filled.snippet });
	return filled;
}

export async function fillCards(cards: ProductCard[], opts: FillCardsOptions): Promise<ProductCard[]> {
	const model = opts.provider.model?.trim();
	if (!model) return cards;
	return Promise.all(cards.map((card) => fillCard(card, opts, model)));
}
