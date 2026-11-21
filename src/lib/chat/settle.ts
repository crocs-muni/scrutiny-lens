/**
 * Chat settle gate (issue #30, ADR 0003) — the deterministic passes that turn
 * model text into a renderable answer:
 *
 *   resolveFinal scans every marker (single owner: chat/markers.ts), resolves
 *     it through the per-session citation registry and the quote gate, and
 *     rewrites it to the registry's canonical `[N]`. An unresolvable or
 *     malformed marker is stripped outright (user ruling 2026-09-17: corrupt
 *     payloads and tokens with no verdict must never render).
 *   scrubAnswer (chat/answer.ts) then deletes each marker whose OWN occurrence
 *     failed the gate, so the rendered answer carries verified claims only.
 *
 * The settled transcript and the LIVE stream run this same pair (#134):
 * `settleStream` applies it to the readable prefix of the accumulated stream.
 * A closed claim's quote is final — the stream only appends — so its verdict
 * can be decided the moment the marker closes, and the streaming answer is a
 * sequence of individually attributed claims instead of one undivided block.
 *
 * Verdicts are per claim, never per number: two claims citing one event with
 * different quotes stay separate (the registry pins the event; the gate
 * decides the quote).
 */

import { z } from 'zod';
import { extractedGate, type ExtractionState } from '../ai/verifier';
import { canonicalContentOf } from '../ai/canonical';
import {
	CITATION_SLOTS,
	createCitationRegistry,
	type Citation,
	type CitationRegistry
} from '../ai/citationRegistry';
import { bestIdentifier } from '../ai/projector';
import type { NostrEvent } from '../fabric';
import { layoutAnswer, scrubAnswer, type AnswerPart } from './answer';
import { scanMarkers } from './markers';
import { readablePrefix } from './streamParse';

/** Resolved citation in a final chat frame (view-models.md §3.7). */
export interface ChatCitation extends Citation {
	/** Computed at resolve-time by the verifier — never model opinion. */
	support: ExtractionState;
	status: 'resolved';
	/** Deterministic palette slot: (n - 1) % CITATION_PALETTE.length (registry I1). */
	colorIndex: number;
}

export interface ClaimsSummary {
	total: number;
	verbatim: number;
	partial: number;
	extrapolatory: number;
}

const markerPayloadSchema = z.object({
	eventId: z.string().min(1),
	quote: z.string()
});

function nodeTitleOf(event: NostrEvent): string {
	return (bestIdentifier(event) ?? event.content.split('\n')[0].trim()).slice(0, 80);
}

/** The settle gate over a finished answer — the agent's final frame and the
 * live surface (settleStream) share it, so the wire and the screen can never
 * disagree about which claims survived. */
export function resolveFinal(
	fullText: string,
	events: NostrEvent[],
	registry: CitationRegistry
): { content: string; citations: ChatCitation[]; claimsSummary?: ClaimsSummary } {
	const citations: ChatCitation[] = [];
	const summary: ClaimsSummary = { total: 0, verbatim: 0, partial: 0, extrapolatory: 0 };
	/** One edit per scanned marker, applied by OFFSET — never by string
	 * replacement. A marker's raw text is not unique (two claims can cite the
	 * same event with the same payload), and a bare `[1]` strip would also
	 * match the canonical `[1]` another edit inserts, so `split/join` could
	 * rewrite a marker twice. Offsets make each scan touch exactly its span. */
	const edits: Array<{ start: number; end: number; replacement: string }> = [];

	/** Strip a marker run, swallowing one adjacent space so no orphan
	 * whitespace remains; other whitespace is literal content (indent-preserved
	 * blocks, hard breaks) and is never collapsed globally. */
	const stripAt = (start: number, end: number): void => {
		const precededBySpace = start > 0 && fullText[start - 1] === ' ';
		edits.push({ start: precededBySpace ? start - 1 : start, end, replacement: '' });
	};

	for (const scan of scanMarkers(fullText)) {
		// A bare canonical `[N]` carries no payload, so no verdict can belong to
		// it (STRIP-uniform, ruling 2026-09-17). Strip it HERE, not in
		// scrubAnswer: there the gate pairs markers with resolved citations by
		// occurrence (#187), and a bare token would consume the verdict meant
		// for the next citation of its number.
		if (!scan.braced) {
			stripAt(scan.start, scan.end);
			continue;
		}

		let resolvedCitation: ChatCitation | undefined;
		if (scan.objectText !== null) {
			const payload = markerPayloadSchema.safeParse(
				(() => {
					try {
						return JSON.parse(scan.objectText as string);
					} catch {
						return undefined;
					}
				})()
			);
			if (payload.success) {
				const event = events.find((e) => e.id === payload.data.eventId);
				const res = registry.resolve(payload.data.eventId, events, payload.data.quote, event ? nodeTitleOf(event) : undefined);
				if (res.ok && event) {
					// #163: the quote is checked against the RESOLVED content — a
					// root-author patch makes the raw content history (spec §2
					// rule 3; the canonical-content note in
					// docs/vision/agentic-harness.md). Unresolvable canonical
					// content leaves the citation unverified rather than falling
					// back to raw text.
					const canonical = canonicalContentOf(event.id, events);
					const gate =
						canonical === undefined
							? { state: 'extrapolatory' as const, span: undefined }
							: extractedGate(payload.data.quote, canonical);
					resolvedCitation = {
						...res.citation,
						support: gate.state,
						verified: gate.state !== 'extrapolatory',
						status: 'resolved',
						colorIndex: (res.citation.n - 1) % CITATION_SLOTS
					};
				}
			}
		}

		if (resolvedCitation) {
			citations.push(resolvedCitation);
			summary.total += 1;
			summary[resolvedCitation.support] += 1;
			// Canonical renumber: the registry's stable [N], not the model's.
			edits.push({
				start: scan.start,
				end: scan.end,
				replacement: `[${resolvedCitation.n}]`
			});
		} else {
			// Unresolvable OR malformed (parseless/unterminated braces): strip
			// the whole marker — a failed/malformed citation must leave no
			// trace on the settled surface (user ruling 2026-09-17 — the
			// flat-capture predecessor leaked corrupt JSON into the PQC answer).
			stripAt(scan.start, scan.end);
		}
	}

	// Scans arrive in text order, so a single forward pass rebuilds content.
	let content = '';
	let cursor = 0;
	for (const edit of edits) {
		content += fullText.slice(cursor, edit.start) + edit.replacement;
		cursor = edit.end;
	}
	content += fullText.slice(cursor);
	return {
		content,
		citations,
		claimsSummary: citations.length > 0 ? summary : undefined
	};
}

/**
 * Settle the CLOSED prefix of an in-flight answer (#134). Everything before
 * the withheld tail is final — the stream only appends — so running the same
 * gate the transcript will run at settle cannot produce a different verdict
 * later: a claim that shows a pill mid-stream shows that pill after it lands,
 * and a claim whose quote the gate rejects never gets one.
 *
 * Stateless: callers re-run it on the whole accumulated string per delta.
 */
export function settleStream(
	raw: string,
	events: NostrEvent[],
	registry: CitationRegistry
): { content: string; citations: ChatCitation[] } {
	const resolved = resolveFinal(readablePrefix(raw), events, registry);
	return scrubAnswer(resolved.content, resolved.citations);
}

/**
 * The live surface's render input: the settled prefix laid out into the same
 * runs and pills the transcript renders. The column and its DOM test call
 * this one function, so the streaming surface cannot drift from the code the
 * test observes.
 */
export function streamParts(
	raw: string,
	events: NostrEvent[],
	registry: CitationRegistry
): { parts: AnswerPart[]; citations: ChatCitation[] } {
	const settled = settleStream(raw, events, registry);
	return { parts: layoutAnswer(settled.content, settled.citations), citations: settled.citations };
}

/**
 * Error-lane prose (ruling 6): the stream's partial text with every marker
 * suppressed and nothing styled — verification never ran, so no citation may
 * surface. The gate runs against an empty grounding set (nothing resolves,
 * every token strips) and a throwaway registry, so a turn that persists
 * nothing cannot move the conversation's numbering.
 */
export function markerless(raw: string): string {
	return resolveFinal(readablePrefix(raw), [], createCitationRegistry()).content;
}
