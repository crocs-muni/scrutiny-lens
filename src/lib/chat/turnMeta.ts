/**
 * Turn metadata for the settled chat surface (issue #185).
 *
 * Everything here is COMPUTED — spec §2 rule 5: counts, statuses and dates are
 * deterministic, never model prose. The one number that came from the model's
 * turn (`claimsSummary.extrapolatory`) is a *verification result*, not a
 * statement the model wrote.
 *
 * Why `dropped` and not "N verified": `scrubAnswer` deletes every marker whose
 * citation failed verification before the answer renders, so a rendered pill
 * is verified by construction and "3 verified" can only ever be true. What can
 * be false — and therefore is worth saying — is how many claims the checker
 * threw away.
 */

import {
	DELETION_KIND,
	isDefaultViewRetracted,
	type CoreNostrEvent,
	type NostrEvent
} from '$lib/fabric';
import type { PersistedChatCitation, PersistedChatMessage } from '$lib/db';

/** Protocol status of the cited record (spec §2 rule 2). `unknown` means the
 * record is not in the session's grounding set — never a guess. */
export type RecordStatus = 'current' | 'retracted' | 'unknown';

export interface SourceRow {
	n: number;
	eventId: string;
	/** Existing AI-written node title (spec §2.1 allows it) or the honest
	 * fallback the footer already used. */
	title: string;
	/** The verified span when the citation carries one — verbatim by
	 * construction (ADR 0003). */
	quote: string;
	colorIndex: number;
	status: RecordStatus;
}

export interface TurnMeta {
	/** Distinct citations, in registry (reading) order. */
	sources: SourceRow[];
	/** Status partition over `sources` — sums to `sources.length` exactly. */
	counts: { current: number; retracted: number; unknown: number };
	/** Markers the verifier resolved that produced NO visible marker — i.e.
	 * claims actually removed from the rendered answer. Derived from what
	 * rendered, never from the model's own count: two claims can renumber to
	 * the same citation number, and `scrubAnswer` keys its verified set by
	 * number, so a merely-reported "extrapolatory" can survive on screen. A
	 * number that says "dropped" while the claim is still visible would be
	 * the exact lie this surface exists to avoid. */
	dropped: number;
	/** True when every source carries a known status, i.e. the partition can
	 * be printed without an `unknown` bucket nobody wants to read. */
	statusComplete: boolean;
}

/** Deletion markers in the session's admitted set, cast once at the seam
 * (the fabric header's own policy for core's readonly wire type). */
function deletionsOf(grounding: readonly NostrEvent[]): CoreNostrEvent[] {
	return grounding
		.filter((e) => e.kind === DELETION_KIND)
		.map((e) => e as unknown as CoreNostrEvent);
}

/** Canonical marker in settled content (`[3]`) — the same token grammar
 * `layoutAnswer` renders. */
const MARKER = /\[\d+\]/g;

/** Distinct citations by number, first occurrence wins (two claims, one
 * source — the same dedupe the footer carried). */
function uniqueCitations(citations: readonly PersistedChatCitation[]): PersistedChatCitation[] {
	const seen = new Set<number>();
	const out: PersistedChatCitation[] = [];
	for (const c of citations) {
		if (seen.has(c.n)) continue;
		seen.add(c.n);
		out.push(c);
	}
	return out;
}

export function buildTurnMeta(
	message: Pick<PersistedChatMessage, 'content' | 'citations' | 'claimsSummary'>,
	grounding: readonly NostrEvent[]
): TurnMeta {
	const deletions = deletionsOf(grounding);
	const byId = new Map(grounding.map((e) => [e.id, e]));
	const sources: SourceRow[] = uniqueCitations(message.citations ?? []).map((c) => {
		const event = byId.get(c.eventId);
		let status: RecordStatus = 'unknown';
		if (event !== undefined) {
			status = isDefaultViewRetracted(event as unknown as CoreNostrEvent, deletions)
				? 'retracted'
				: 'current';
		}
		return {
			n: c.n,
			eventId: c.eventId,
			title: c.nodeTitle ?? 'Cited event',
			quote: c.span ?? c.quote,
			colorIndex: c.colorIndex,
			status
		};
	});

	const counts = { current: 0, retracted: 0, unknown: 0 };
	for (const s of sources) counts[s.status] += 1;

	// Resolved citations vs markers still in the rendered text. A marker that
	// vanished was a removed claim; a claim the checker rejected but whose
	// number survived (two claims, one source) is still on screen, so it must
	// not be reported as dropped.
	const resolved = message.claimsSummary?.total ?? 0;
	const rendered = (message.content.match(MARKER) ?? []).length;

	return {
		sources,
		counts,
		dropped: Math.max(0, resolved - rendered),
		statusComplete: counts.unknown === 0
	};
}

/** The mono meta line under the turn kicker: `3 sources · 2 current · 1
 * retracted`. Without a known status for every source it degrades to the
 * count alone — a partial partition would read as a lie. */
export function countsLine(meta: TurnMeta): string {
	// An answer with no citations prints no counts at all: "0 sources" is
	// chrome pretending to be information.
	if (meta.sources.length === 0) return '';
	const sources = `${meta.sources.length} source${meta.sources.length === 1 ? '' : 's'}`;
	if (!meta.statusComplete) return sources;
	const parts: string[] = [];
	if (meta.counts.current > 0) parts.push(`${meta.counts.current} current`);
	if (meta.counts.retracted > 0) parts.push(`${meta.counts.retracted} retracted`);
	return parts.length === 0 ? sources : `${sources} · ${parts.join(' · ')}`;
}
