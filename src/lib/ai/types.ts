import { z } from 'zod';

export const AIErrorKind = z.enum(['no-key', 'timeout', 'gateway', 'parse', 'validation', 'empty']);
export type AIErrorKind = z.infer<typeof AIErrorKind>;

export type AIResult<T> =
	| { ok: true; result: T; cached?: boolean }
	| { ok: false; kind: AIErrorKind; message: string };

export const FilterPlan = z.object({
	interpretation: z.string(),
	filters: z.array(
		z.object({
			mode: z.enum(['identifier', 'freetext', 'browse']),
			identifier: z.string().optional(),
			search: z.string().optional(),
			types: z.array(z.string()).default([])
		})
	)
});
export type FilterPlan = z.infer<typeof FilterPlan>;

export const SearchCard = z.object({
	eventId: z.string(),
	title: z.string(),
	badges: z.array(z.string()),
	snippet: z.string()
});
export type SearchCard = z.infer<typeof SearchCard>;

// Deliberately narrow: subtitle is derived from real tags (see
// session/nodeDisplay.ts's deriveSubtitle) and the drawer shows the event's
// real content -- the LLM's only job is a short title and a few badges.
export const GraphNode = z.object({
	eventId: z.string(),
	title: z.string(),
	badges: z.array(z.string())
});
export type GraphNode = z.infer<typeof GraphNode>;

export const FollowUps = z.object({
	questions: z.array(z.string())
});
export type FollowUps = z.infer<typeof FollowUps>;

export const Citation = z.object({
	n: z.coerce.number(),
	id: z.string(),
	// A VERBATIM, character-for-character substring copied from the cited
	// event's own content -- not a paraphrase. This is what lets the node
	// drawer show a "cited passage" that's checked against the real event
	// text instead of a fuzzy guess (see citationRender.ts's verifyQuote).
	quote: z.string()
});
export type Citation = z.infer<typeof Citation>;

export const ChatTurn = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.string()
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const ChatRequest = z.object({
	question: z.string(),
	history: z.array(ChatTurn).default([]),
	events: z.array(z.record(z.string(), z.unknown())).default([]),
	rootSummary: z.string()
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z.object({
	answer: z.string(),
	citations: z.array(Citation).default([])
});
export type ChatResponse = z.infer<typeof ChatResponse>;

export const SOURCES_SENTINEL = '%%CITATIONS%%';
