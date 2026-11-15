// Deterministic capability answers (issue #133, spec §2 rules 2 and 6).
//
// A capability question — "what does this session contain?", "what can you
// answer?" — fits neither grounded exit the chat agent has. The citation
// grammar can only quote an event, and the honest answer enumerates the
// session itself; the refusal exit is gated on the model deciding it "still"
// cannot answer, which it externalizes as rumination (measured in the
// 2026-10-19 review: the turn never settled). The facts the question asks
// for are computed, not written: counts over the admitted set. Answering here
// costs no model call, works with no key at all, and cannot loop.

import type { NostrEvent } from 'nostr-tools/core';
import { tTags } from '$lib/fabric';

/** The session facts a capability question asks for (spec §2 rule 2: counts
 * are computed from the admitted set, never written by the model). */
export interface SessionFacts {
	/** Admitted events — the citable scope (ADR 0002). */
	total: number;
	/** Root products (i-tag `scrutiny-product`). */
	products: number;
	/** Everything else: tests, advisories, bindings, specs. */
	metadata: number;
}

export function sessionFacts(events: readonly NostrEvent[]): SessionFacts {
	const products = events.filter((event) => tTags(event).includes('scrutiny-product')).length;
	return { total: events.length, products, metadata: events.length - products };
}

/** Meta questions the deterministic lane owns. Deliberately narrow: a
 * question that names an identifier is about a record, not about the
 * session, and must reach the grounded lane. */
const META_QUESTION: readonly RegExp[] = [
	/\bwhat (can|do) you (do|answer|know|see|have)\b/,
	/\bwhat (are|is) you\b/,
	/\bwho are you\b/,
	/\bwhat (does|is) this (app|tool|thing)\b/,
	/\bhow (do|should) i (use|ask|search)\b/,
	/\bwhat (can|should) i ask\b/,
	/\bwhat (questions|kind of questions)\b/,
	/\bwhat (data|information|events)\b[^?]*\b(session|here|available)\b/,
	/\bwhat (does|do) (this|the) session (contain|hold|have)\b/,
	/\bwhat (is|'s) in (this|the) session\b/,
	/\bwhat (is|'s) (in here|available)\b/,
	/\bsession contain/,
	/\bwhat can this (app|tool|session|graph|screen)\b/,
	/^(help|what)\s*[?!.]*$/
];

/** Identifier questions belong to the grounded lane even when they read like
 * meta questions ("what can you tell me about CVE-2017-15361"). */
const IDENTIFIER = /\b(cve-\d{4}-\d+|ghsa-[a-z0-9]{4,})|purl:|cpe:|cc:|fips:|fcc-id:|swid:|gtin:|pp:|scheme:/i;

export function isCapabilityQuestion(question: string): boolean {
	const text = question.toLowerCase().trim();
	if (text === '') return false;
	if (IDENTIFIER.test(text)) return false;
	return META_QUESTION.some((pattern) => pattern.test(text));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The computed answer, or null when the question is not a capability
 * question. The count is the set this chat can CITE (the subject cohort on a
 * card, the admitted set otherwise), so the copy says "this chat", never
 * "this session": a session that fetched 133 events can still hold 10 in
 * scope, and claiming the larger number would be a lie (spec §2 rule 2). */
export function capabilityAnswer(question: string, events: readonly NostrEvent[]): string | null {
	if (!isCapabilityQuestion(question)) return null;
	const facts = sessionFacts(events);
	if (facts.total === 0) {
		return 'This chat has no admitted events to cite yet, so there is nothing to answer from. Run a search first: I answer only from the events the relays returned.';
	}
	return [
		`This chat can cite ${plural(facts.total, 'admitted event', 'admitted events')}: ` +
			`${plural(facts.products, 'product', 'products')} and ` +
			`${plural(facts.metadata, 'metadata record', 'metadata records')}.`,
		'I answer only from those events and quote the event behind every claim.',
		'Ask about a product, its tests, its advisories, or its patch history.'
	].join(' ');
}
