// The per-card AI fill state as a closed set (spec §2 rule 2 + rule 5), and
// the pure functions that reconcile it with a fresh deterministic assembly.
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
 * - `interpreted`: a record has painted — the AI-written title/snippet that
 *   must survive any deterministic re-assembly.
 *
 * A lane's `pending` set (claimed but not painted) carries nothing the card
 * itself needs to protect: drafts live in the store, and an unpainted card
 * has no paint to lose — so the classifier never emits a pending state and
 * the merge needs no pending argument.
 *
 * The INPUT fields can hold pending and interpreted at once (a streamed
 * paint lands while the chunk is still claimed); the classifier takes the
 * advanced one, so the union itself never carries the overlap.
 */
export type CardFill =
	| { kind: 'raw' }
	| { kind: 'interpreted'; title: string; snippet: string | undefined };

/** Live state as the machine sees it: `interpreted` only when the card says so. */
export function cardFillOf(card: ProductCard): CardFill {
	return card.interpreted
		? { kind: 'interpreted', title: card.title, snippet: card.snippet }
		: { kind: 'raw' };
}

/** One rule, used in both merge directions: the paint rides the fresh facts. */
function withPaint(base: ProductCard, title: string, snippet: string | undefined): ProductCard {
	return { ...base, title, snippet, interpreted: true };
}

/**
 * The settle-direction merge: fresh deterministic facts for every card the
 * full admitted set contains, live AI paint preserved, context arrivals
 * appended in assembly order. `candidate === undefined` means the fresh set
 * no longer holds the card — keep whatever is live, because "the card I am
 * looking at" outranks "the graph forgot it".
 */
export function mergeSettledCards(
	live: readonly ProductCard[],
	fresh: readonly ProductCard[]
): ProductCard[] {
	const freshById = new Map(fresh.map((card): [string, ProductCard] => [card.id, card]));
	const liveIds = new Set(live.map((card) => card.id));
	const merged = live.map((card) => {
		const candidate = freshById.get(card.id);
		if (candidate === undefined) return card;
		return card.interpreted
			? withPaint(candidate, card.title, card.snippet)
			: candidate;
	});
	for (const card of fresh) if (!liveIds.has(card.id)) merged.push(card);
	return merged;
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
export function paintCard(live: ProductCard | undefined, painted: ProductCard): ProductCard {
	if (live === undefined) return painted;
	if (!painted.interpreted) return live;
	return withPaint(live, painted.title, painted.snippet);
}
