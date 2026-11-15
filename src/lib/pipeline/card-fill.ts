// The per-card AI fill state as a closed set (spec §2 rule 2 + rule 5), and
// the one pure function that reconciles it with a fresh deterministic
// assembly.
//
// Why this exists: after the §8.2 traversal, `start()` re-assembles every
// card from the full admitted set. Before this seam the merge kept the whole
// PRE-context card whenever a fill lane had claimed or painted it — so its
// computed counts (`boundMetadata`, `files`, `updates`) stayed stale while
// the session header counted the full set ("0 metadata" beside "3 metadata").
// The only fields worth protecting across the merge are the AI-written paint
// (title, snippet, interpreted), never the computed facts.

import type { ProductCard } from './cards';

/**
 * What the fill lane has done to one card so far.
 *
 * - `raw`: nobody has claimed or painted it (rule-5 fallback face).
 * - `pending`: a lane claimed it but no record has painted yet. Drafts live
 *   in the store (`investigation.drafts`), never on the card, so nothing on
 *   the card itself is worth keeping.
 * - `interpreted`: a record has painted — the AI-written title/snippet that
 *   must survive any deterministic re-assembly.
 *
 * `pending` and `interpreted` can be true simultaneously in the input fields
 * (streaming paints mid-pass); `interpreted` wins because it is strictly more
 * advanced truth, matching the lane's own "never revert to raw" rule.
 */
export type CardFill =
	| { kind: 'raw' }
	| { kind: 'pending' }
	| { kind: 'interpreted'; title: string; snippet: string | undefined };

export function cardFillOf(card: ProductCard, pending: ReadonlySet<string>): CardFill {
	if (card.interpreted) return { kind: 'interpreted', title: card.title, snippet: card.snippet };
	if (pending.has(card.id)) return { kind: 'pending' };
	return { kind: 'raw' };
}

function unreachable(kind: never): never {
	throw new Error(`unreachable card fill state: ${String(kind)}`);
}

/**
 * The fill-state transition a fresh deterministic assembly drives.
 *
 * `candidate === undefined` means the fresh assembly does not contain the
 * card any more (it dropped out of the context set): keep whatever is live,
 * because "the card I am looking at" outranks "the graph forgot it".
 * Every other outcome takes the candidate's computed facts; only the AI
 * paint is carried over from the live card.
 */
export function settleCard(
	live: ProductCard,
	fill: CardFill,
	candidate: ProductCard | undefined
): ProductCard {
	if (candidate === undefined) return live;
	switch (fill.kind) {
		case 'raw':
		case 'pending':
			return candidate;
		case 'interpreted':
			return { ...candidate, title: fill.title, snippet: fill.snippet, interpreted: true };
		default:
			return unreachable(fill);
	}
}

/**
 * The fill-direction counterpart: a lane that settles or paints a card must
 * paint onto the FRESHEST facts, never onto the card it claimed.
 *
 * `this.cards` may have been refreshed by the traversal merge while a pass
 * was mid-flight. Letting the pass write its own snapshot back (`merged[at] =
 * filled[i]`) re-installed the pre-context counts — the second half of the
 * bug above. A raw settle keeps the live card (fresher raw truth); an
 * interpreted settle keeps only the paint fields.
 */
export function paintCard(
	live: ProductCard | undefined,
	painted: ProductCard
): ProductCard {
	if (live === undefined) return painted;
	if (!painted.interpreted) return live;
	return { ...live, title: painted.title, snippet: painted.snippet, interpreted: true };
}

/**
 * Post-traversal merge: fresh deterministic truth for every card the full
 * admitted set contains, live AI paint preserved, context arrivals appended
 * in assembly order. Pure by construction — no store handles, no sets other
 * than the caller-owned `pending` used only to classify the input state.
 */
export function mergeSettledCards(
	live: readonly ProductCard[],
	fresh: readonly ProductCard[],
	pending: ReadonlySet<string>
): ProductCard[] {
	const freshById = new Map(fresh.map((card): [string, ProductCard] => [card.id, card]));
	const liveIds = new Set(live.map((card) => card.id));
	const merged = live.map((card) =>
		settleCard(card, cardFillOf(card, pending), freshById.get(card.id))
	);
	for (const card of fresh) if (!liveIds.has(card.id)) merged.push(card);
	return merged;
}
