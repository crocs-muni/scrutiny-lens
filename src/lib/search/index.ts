/**
 * Local search seam (issue #27; engine ruling on #12): FlexSearch behind a
 * small interface — MiniSearch stays one import away if ranking taste fails.
 * The engine is lazy: created and hydrated from the events cache on FIRST
 * use, so the module is code-split out of the boot path.
 *
 * Honesty contract (spec §3): this is a LOCAL index over the cache — a
 * cache-empty result must never surface as "no matches"; callers label
 * cache results "local cache only". Deterministic filtering (kind, pubkey,
 * time) stays out of the engine — the t-tag/created_at indexes in $lib/db
 * cover it.
 */

import { cacheEvent, listEvents} from '$lib/db';
import type { NostrEvent } from '$lib/fabric';

/** The narrow contract any engine swap must satisfy. */
export interface EventsSearch {
	add(doc: { id: string; content: string; tags: string[] }): void;
	search(query: string, limit: number): string[];
}

async function createFlexSearchEngine(): Promise<EventsSearch> {
	const { Document } = await import('flexsearch');
	// 'tolerant' tokenizer, probed on #27: catches transpositions and dropped
	// letters ('certifcate', 'vunerability') and prefixes ('infineo'); drifts
	// of 2 chars are its floor. Content field searched before tags, so prose
	// matches outrank tag matches when the lists merge.
	const doc = new Document<{ id: string; content: string; tags: string }>({
		document: { id: 'id', index: ['content', 'tags'] },
		tokenize: 'tolerant'
	});
	return {
		add: (e) => void doc.add({ id: e.id, content: e.content, tags: e.tags.join(' ') }),
		search: (query, limit) => {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const fieldResult of doc.search(query, { suggest: true, limit })) {
				for (const id of fieldResult.result) {
					const key = String(id);
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(key);
				}
			}
			return out.slice(0, limit);
		}
	};
}

let enginePromise: Promise<EventsSearch> | null = null;

/** Lazily creates the engine and hydrates it from the events cache. A
 * REJECTED creation (stale chunk after a deploy, flaky network, engine
 * constructor throwing) is dropped so the next call retries — the memoized
 * rejection would otherwise poison search for the session's lifetime. */
function engine(): Promise<EventsSearch> {
	enginePromise ??= (async () => {
		const search = await createFlexSearchEngine();
		for (const event of await listEvents()) {
			search.add({ id: event.id, content: event.content, tags: event.ttags });
		}
		return search;
	})();
	enginePromise.catch(() => {
		enginePromise = null;
	});
	return enginePromise;
}

/** Degrade posture matches $lib/db's attempt() (spec §6): the user never
 * sees an engine failure (empty/"local cache only" results are honest),
 * the developer hears about it. */
function warn(error: unknown): void {
	console.warn(`[search] engine unavailable — ${error instanceof Error ? error.message : String(error)}`);
}

const DEFAULT_LIMIT = 50;

/** Ranked, typo-tolerant id matches over the local cache. */
export async function searchText(query: string, limit = DEFAULT_LIMIT): Promise<string[]> {
	try {
		return (await engine()).search(query, limit);
	} catch (error) {
		warn(error);
		return [];
	}
}

/** Write-through set: both halves see exactly the same, redacted row —
 * indexEvent adds only what the cache actually stored (never the raw
 * event), and an add is skipped when the write degraded (spec §6), so the
 * store and the engine can't diverge. */
export async function indexEvent(event: NostrEvent): Promise<void> {
	const row = await cacheEvent(event);
	if (row === null) return;
	try {
		(await engine()).add({ id: row.id, content: row.content, tags: row.ttags });
	} catch (error) {
		warn(error);
	}
}

/** Test seam — drops the engine and its hydration promise. */
export function resetSearchEngine(): void {
	enginePromise = null;
}
