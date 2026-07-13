// Deterministic (non-AI) display helpers derived straight from an event's
// own tags -- the LLM's job is limited to `title`/`badges` (see
// ai/agents/nodes.ts); everything else shown about a node should be real
// data, not a paraphrase.
import type { NostrEvent } from './types.js';

const SUBTITLE_TAG_PREFIXES = ['vendor:', 'scheme:', 'lab:'];

/** "vendor · scheme · lab" built from whichever of those `i` tags are
 *  present, in that order -- falls back to a pubkey slice if none are. */
export function deriveSubtitle(event: NostrEvent): string {
	const values = event.tags.filter((t) => t[0] === 'i' && typeof t[1] === 'string').map((t) => t[1]);
	const parts = SUBTITLE_TAG_PREFIXES.map((prefix) => values.find((v) => v.startsWith(prefix))?.slice(prefix.length)).filter(
		(v): v is string => Boolean(v)
	);
	return parts.length > 0 ? parts.join(' · ') : event.pubkey.slice(0, 24);
}
