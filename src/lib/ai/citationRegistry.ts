// Keeps citation numbers stable across a whole chat conversation. Each new
// assistant message re-numbers its own citations from 1 (simplest for the
// model, which has no visibility into earlier messages' numbering) -- this
// module resolves those message-local numbers against a running
// eventId -> global-number map, so citing the same event in message 3 that
// message 1 already cited as [2] shows [2] again instead of restarting at
// [1], giving the reader a visible link between the two.
import type { Citation } from './types.js';

export type CitationRegistry = Map<string, number>;

export function createCitationRegistry(): CitationRegistry {
	return new Map();
}

/**
 * Resolves a message's local citation numbers against the registry,
 * allocating a new global number for any event id seen for the first time.
 * Returns the citations with `n` rewritten to the global number, plus a
 * local->global map for remapping the answer text's own [n] markers.
 */
export function resolveGlobalCitations(
	registry: CitationRegistry,
	citations: Citation[]
): { resolved: Citation[]; localToGlobal: Map<number, number> } {
	const localToGlobal = new Map<number, number>();
	let nextNumber = registry.size > 0 ? Math.max(...registry.values()) + 1 : 1;

	for (const c of citations) {
		let global = registry.get(c.id);
		if (global === undefined) {
			global = nextNumber++;
			registry.set(c.id, global);
		}
		localToGlobal.set(c.n, global);
	}

	const resolved = citations.map((c) => ({ ...c, n: localToGlobal.get(c.n) ?? c.n }));
	return { resolved, localToGlobal };
}

/**
 * Rewrites an answer's [n] pill markers from local to global numbering.
 * A single regex.replace pass over the ORIGINAL string is safe from
 * local/global number collisions (e.g. local [1] -> global [3] while the
 * text also contains an unprocessed local [3]) -- String.replace resolves
 * all matches against the input text up front, so a freshly-written [3]
 * can never be re-matched as if it were an original marker.
 */
export function remapAnswerMarkers(text: string, localToGlobal: Map<number, number>): string {
	return text.replace(/\[(\d+)\]/g, (full, numStr: string) => {
		const global = localToGlobal.get(Number(numStr));
		return global === undefined ? full : `[${global}]`;
	});
}
