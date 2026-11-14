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

	it('strips bare numbers with no verified backing (user ruling 2026-09-17)', () => {
		// Supersedes the AI-Elements "unmatched marker stays literal inert
		// text" precedent: a recordless [N] on screen reads as a rendering
		// bug (live PQC-chat complaint: bare "[3]" over THALES claims).
		const out = scrubAnswer('Bare [9] reference.', []);
		expect(out.content).toBe('Bare reference.');
	});
});

/* #187: two claims can renumber onto ONE registry number (the same event
 * cited twice — one quote verbatim, one extrapolatory). A gate keyed by
 * number then keeps the convicted claim's marker because its twin's number
 * is verified: the screen shows two claims under [1] and only one is
 * supported. spec §2 rules 2 and 5 — a citation mark is a computed claim,
 * never decoration — so the gate keys by marker OCCURRENCE in reading order. */
describe('scrubAnswer — occurrence-keyed gate', () => {
	it('drops the extrapolatory twin that renumbered onto a verified number', () => {
		const out = scrubAnswer(
			'Keygen uses the affected library [1]. Availability was extended to 2029 [1].',
			[
				{ n: 1, verified: true },
				{ n: 1, verified: false }
			]
		);
		expect(out.content).toBe('Keygen uses the affected library [1]. Availability was extended to 2029.');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
	});

	it('renders one pill and one marked sentence for the two-claims-one-number case', () => {
		const settled = scrubAnswer('First claim [1]. Second claim [1].', [
			{ n: 1, verified: true },
			{ n: 1, verified: false }
		]);
		const parts = layoutAnswer(settled.content, settled.citations);
		expect(parts.filter((p) => p.kind === 'pill')).toEqual([{ kind: 'pill', n: 1, marks: [1] }]);
		// the surviving sentence keeps the underline; the convicted one has none
		expect(parts).toEqual([
			{ kind: 'text', text: 'First claim ', marks: [1] },
			{ kind: 'pill', n: 1, marks: [1] },
			{ kind: 'text', text: '. ', marks: [1] },
			{ kind: 'text', text: 'Second claim.', marks: [] }
		]);
	});

	it('keeps the occurrence whose own quote the checker found, not the first of that number', () => {
		const out = scrubAnswer(
			'The report claims a 9.8 severity [1]. The library is ROCA-affected [1].',
			[
				{ n: 1, verified: false },
				{ n: 1, verified: true }
			]
		);
		expect(out.content).toBe('The report claims a 9.8 severity. The library is ROCA-affected [1].');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
	});

	it('keeps two occurrences of one number when both citations are verified', () => {
		const content = 'ROCA affects keygen [1] and signing [1].';
		const both = [
			{ n: 1, verified: true },
			{ n: 1, verified: true }
		];
		const out = scrubAnswer(content, both);
		expect(out.content).toBe(content);
		expect(out.citations).toEqual(both);
	});

	it('drops a marker occurrence with no resolved citation of its number', () => {
		// A bare repeat of an already-cited number is an unbacked claim: one
		// verified citation backs one occurrence, never every [N] that
		// happens to carry its number.
		const out = scrubAnswer('Affected cards [1] and again [1].', [{ n: 1, verified: true }]);
		expect(out.content).toBe('Affected cards [1] and again.');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
	});

	it('a bare marker cannot shift the gate onto another claim', () => {
		// resolveFinal leaves the model's own bare [N] tokens in the text
		// (markers.ts: those carry no payload). Pairing is per number, so a
		// stray [9] cannot consume the verdict meant for claim [1].
		const out = scrubAnswer('Model echo [9]. Claim [1] here. Bogus [2] there.', [
			{ n: 1, verified: true },
			{ n: 2, verified: false }
		]);
		expect(out.content).toBe('Model echo. Claim [1] here. Bogus there.');
		expect(out.citations).toEqual([{ n: 1, verified: true }]);
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
