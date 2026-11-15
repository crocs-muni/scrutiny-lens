/**
 * #163 — the content a quote is verified against is the RESOLVED content.
 *
 * Verifying against `event.content` lets a quote taken from pre-patch text
 * count as present-tense support: once a root-author patch has replaced that
 * text, the canonical content is the patched text, and the raw event is
 * history. Presenting a stale quote as current support is the never-lie rule
 * (spec §2 rule 3, and the "verified against resolved canonical content, not
 * the raw event" note in `docs/vision/agentic-harness.md`) arriving through
 * its own gate — which is why a citation verifies against canonical content.
 *
 * `core.resolve()` is the sole patch source (AGENTS.md hard rule); this module
 * is a one-call adapter over it, deliberately small so the real home —
 * `verifySpan()` in crocs-muni/scrutiny-fabric-tools#103 — can replace it
 * without changing any caller.
 */
import { resolve, type NostrEvent } from '$lib/fabric';

/**
 * The canonical content of `eventId` within `events`, or `undefined` when it
 * cannot be established.
 *
 * Three cases, all decided by `core.resolve()`:
 *   - a Product/Metadata root resolves (with or without patches) — the chain
 *     content, which equals `event.content` when the chain carries none (RC-5);
 *   - an event that cannot carry a chain at all (binding, profile, deletion,
 *     non-fabric) — its own content, because BD-9 corrects those by retraction
 *     and replacement, never by patching;
 *   - a root absent from the admitted set — nothing, so callers must treat the
 *     quote as unverifiable rather than falling back to raw content.
 *
 * Never returns pre-patch text for a patched root: that is the bug this exists
 * to close.
 */
export function canonicalContentOf(
	eventId: string,
	events: readonly NostrEvent[]
): string | undefined {
	const { chain } = resolve(eventId, events);
	if (chain.status !== 'absent') return chain.content;
	if (chain.reason === 'root-not-patchable') {
		return events.find((event) => event.id === eventId)?.content;
	}
	return undefined;
}
