// Mid-stream per-claim attribution (issue #134).
//
// The streamed answer runs the transcript's own settle gate over the readable
// prefix of the stream, so every CLOSED claim carries its own verdict while
// the unterminated tail stays plain. These tests pin the three acceptance
// properties:
//   1. closed claims get their own pill (per citation number, in reading
//      order) mid-stream;
//   2. a partial marker never styles anything — not the message, not its
//      sentence;
//   3. the quote gate is the settle gate: a claim whose quote is not in the
//      cited event never renders as verified, mid-stream or after.

import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '$lib/fabric';
import { createCitationRegistry } from '$lib/ai/citationRegistry';
import { layoutAnswer } from '$lib/chat/answer';
import { markerless, settleStream } from '$lib/chat/settle';

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

const E1 = event('e1', 'RSA keygen runs in the certified library');
const E2 = event('e2', 'EAL4+ was issued in 2019');
const EVENTS = [E1, E2];

const VERBATIM_1 = 'RSA keygen runs in the certified library';
const VERBATIM_2 = 'EAL4+ was issued in 2019';

const marker = (n: number, eventId: string, quote: string): string =>
	`[${n}]${JSON.stringify({ eventId, quote })}`;

describe('settleStream — closed claims are attributed, the tail stays plain', () => {
	it('gives each closed claim its own pill and withholds the unterminated tail', () => {
		const raw = [
			'The library claim',
			`${marker(1, 'e1', VERBATIM_1)}.`,
			'A second claim',
			`${marker(2, 'e2', VERBATIM_2)}.`,
			'Tail',
			'[3]{"eventId":"e1","quote":"RSA keygen runs'
		].join(' ');

		const { content, citations } = settleStream(raw, EVENTS, createCitationRegistry());

		// Canonical renumber, one mark per claim; the half-written marker and
		// its payload are gone, the prose before it is not.
		expect(content).toBe('The library claim [1]. A second claim [2]. Tail ');
		expect(citations.map((c) => c.n)).toEqual([1, 2]);
		expect(citations.every((c) => c.verified)).toBe(true);
		expect(citations.map((c) => c.quote)).toEqual([VERBATIM_1, VERBATIM_2]);

		const pills = layoutAnswer(content, citations).filter((p) => p.kind === 'pill');
		expect(pills.map((p) => (p.kind === 'pill' ? p.n : null))).toEqual([1, 2]);
	});

	it('never styles anything for a partial marker (negative case)', () => {
		const raw = 'Only claim [1]{"eventId":"e1","quote":"RSA keygen runs in the cer';

		const { content, citations } = settleStream(raw, EVENTS, createCitationRegistry());

		expect(content).toBe('Only claim ');
		expect(citations).toEqual([]);
		// No mark means no claim span: layoutAnswer can only tint a run that
		// belongs to a verified citation.
		expect(layoutAnswer(content, citations)).toEqual([
			{ kind: 'text', text: 'Only claim ', marks: [] }
		]);
	});

	it('drops a claim whose quote is not in the cited event — no pill mid-stream', () => {
		// No two-word run of this quote occurs in e1, so the gate convicts it
		// (a shared phrase like "in the" would count as blockquote-subset
		// support by design).
		const raw = `Bogus ${marker(1, 'e1', 'attacks exploit padding oracles')}.`;

		const { content, citations } = settleStream(raw, EVENTS, createCitationRegistry());

		// Same shape the settled transcript has: the marker and its adjacent
		// space are gone, the sentence stays as unsupported prose.
		expect(content).toBe('Bogus.');
		expect(citations).toEqual([]);
	});

	it('keeps a verdict per occurrence, not per number (#187)', () => {
		const raw = `Good ${marker(1, 'e1', VERBATIM_1)}. Bad ${marker(
			1,
			'e1',
			'wholly invented wording'
		)}.`;

		const { content, citations } = settleStream(raw, EVENTS, createCitationRegistry());

		expect(content).toBe('Good [1]. Bad.');
		expect(citations.map((c) => c.n)).toEqual([1]);
		expect(citations[0].verified).toBe(true);
	});

	it('strips a bare echoed number instead of showing it raw', () => {
		// The live leak the issue comment lists: a bare `[1]` used to sit on
		// the streaming surface until settle removed it.
		const raw = `Echo [1] then the real claim ${marker(1, 'e1', VERBATIM_1)}.`;

		const { content, citations } = settleStream(raw, EVENTS, createCitationRegistry());

		expect(content).toBe('Echo then the real claim [1].');
		expect(citations).toHaveLength(1);
	});

	it('never pins a fabricated event id', () => {
		const registry = createCitationRegistry();
		settleStream(`Claim ${marker(1, 'not-in-session', VERBATIM_1)}.`, EVENTS, registry);
		expect(registry.size()).toBe(0);
	});
});

describe('settleStream — the settled answer cannot disagree', () => {
	it('every mid-stream verdict survives settle unchanged', () => {
		// The second claim's quote fails the gate: it must never appear, and
		// must never take a number away from a later verified claim.
		const full = `One ${marker(1, 'e1', VERBATIM_1)}. Two ${marker(
			2,
			'e2',
			'invented claim text'
		)}. Then tail.`;
		const registry = createCitationRegistry();
		const settled = settleStream(full, EVENTS, registry);

		expect(settled.content).toBe('One [1]. Two. Then tail.');
		expect(settled.citations.map((c) => c.n)).toEqual([1]);

		// Walk the stream one character at a time: each renderable snapshot is
		// a prefix of the settled answer and cites a subset of the same
		// citations. Settle's space-swallow rule can drop the one space in
		// front of a rejected marker once it closes, so trailing whitespace is
		// ignored on the snapshot side — nothing else may move.
		for (let i = 1; i <= full.length; i++) {
			const snap = settleStream(full.slice(0, i), EVENTS, registry);
			expect(settled.content.startsWith(snap.content.trimEnd())).toBe(true);
			for (const citation of snap.citations) {
				const later = settled.citations.find((c) => c.n === citation.n);
				expect(later?.eventId).toBe(citation.eventId);
				expect(later?.quote).toBe(citation.quote);
				expect(later?.verified).toBe(true);
			}
			if (i === full.length) expect(snap.content).toBe(settled.content);
		}
	});
});

describe('markerless — the error lane', () => {
	it('suppresses markers and the withheld tail, styling nothing', () => {
		expect(markerless(`Prose ${marker(1, 'e1', VERBATIM_1)} more [2`)).toBe('Prose more ');
	});
});
