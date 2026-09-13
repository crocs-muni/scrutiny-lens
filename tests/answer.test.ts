import { describe, it, expect } from 'vitest';
import { layoutAnswer, scrubAnswer } from '$lib/chat/answer';

/* Deterministic settle-time gates (ADR 0003): a citation that failed
 * verbatim verification must leave NO trace — not the pill, not the marker,
 * not a claim underline. These tests pin that contract plus the claim-span
 * layout the chat renderer consumes. */

describe('scrubAnswer — failed citations vanish', () => {
	it('removes unverified markers and their citations; keeps verified intact', () => {
		const content = 'Affected [1] and maintained [2].';
		const citations = [
			{ n: 1, verified: true },
			{ n: 2, verified: false }
		];
		const out = scrubAnswer(content, citations);
		expect(out.content).toBe('Affected [1] and maintained.');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
	});

	it('swallows one preceding space so no orphan whitespace remains', () => {
		const out = scrubAnswer('Valid [1] then bogus [2] done.', [
			{ n: 1, verified: true },
			{ n: 2, verified: false }
		]);
		expect(out.content).toBe('Valid [1] then bogus done.');
	});

	it('keeps marker punctuation: a dropped marker before a period leaves the period', () => {
		const out = scrubAnswer('It is affected [3].', [{ n: 3, verified: false }]);
		expect(out.content).toBe('It is affected.');
	});

	it('does not invent markers: unknown [N] in prose is left for layout', () => {
		// Layout treats markers with no citation as literal inert text (the
		// AI-Elements unmatched-marker precedent) — the scrub only removes
		// markers it can PROVE failed verification.
		const out = scrubAnswer('Bare [9] reference.', []);
		expect(out.content).toBe('Bare [9] reference.');
	});
});

describe('layoutAnswer — claim spans and pills', () => {
	const cite = (n: number) => ({ n, verified: true });

	it('a marker mid-answer marks its full sentence, period included', () => {
		const parts = layoutAnswer('Keygen uses the affected library [1]. Validity was extended.', [cite(1)]);
		expect(parts).toEqual([
			{ kind: 'text', text: 'Keygen uses the affected library ', marks: [1] },
			{ kind: 'pill', n: 1, marks: [1] },
			{ kind: 'text', text: '. ', marks: [1] },
			{ kind: 'text', text: 'Validity was extended.', marks: [] }
		]);
	});

	it('a marker trailing its sentence still owns the whole sentence', () => {
		const parts = layoutAnswer('The report states keygen is affected [1]\nNext sentence.', [cite(1)]);
		expect(parts.map((p) => [p.kind, ('text' in p ? p.text : p.n), p.marks])).toEqual([
			['text', 'The report states keygen is affected ', [1]],
			['pill', 1, [1]],
			['text', '\n', [1]],
			['text', 'Next sentence.', []]
		]);
	});

	it('two markers in one sentence merge: shared marks, two pills in order', () => {
		const parts = layoutAnswer('Affected [1] and maintained [2]. No more.', [cite(1), cite(2)]);
		expect(parts).toEqual([
			{ kind: 'text', text: 'Affected ', marks: [1, 2] },
			{ kind: 'pill', n: 1, marks: [1, 2] },
			{ kind: 'text', text: ' and maintained ', marks: [1, 2] },
			{ kind: 'pill', n: 2, marks: [1, 2] },
			{ kind: 'text', text: '. ', marks: [1, 2] },
			{ kind: 'text', text: 'No more.', marks: [] }
		]);
	});

	it('sentence boundary starts after the previous terminator, leading space excluded', () => {
		const parts = layoutAnswer('First claim. Second claim [1].', [cite(1)]);
		expect(parts[0]).toEqual({ kind: 'text', text: 'First claim. ', marks: [] });
		expect(parts[1]).toEqual({ kind: 'text', text: 'Second claim ', marks: [1] });
	});

	it('markers without a citation stay literal inert text (no pill, no marks)', () => {
		const parts = layoutAnswer('Bare [9] reference stays.', []);
		expect(parts).toEqual([{ kind: 'text', text: 'Bare [9] reference stays.', marks: [] }]);
	});

	it('whitespace around mid-sentence markers stays inside the claim span', () => {
		const parts = layoutAnswer('Claim [1]   tail.', [cite(1)]);
		// the whole first sentence is marked; runs keep their literal spaces
		expect(parts).toEqual([
			{ kind: 'text', text: 'Claim ', marks: [1] },
			{ kind: 'pill', n: 1, marks: [1] },
			{ kind: 'text', text: '   tail.', marks: [1] }
		]);
	});
});
