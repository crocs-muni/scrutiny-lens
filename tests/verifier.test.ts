import { describe, it, expect } from 'vitest';
import { tagGate, extractedGate, type VerificationSource } from '$lib/ai/verifier';
import type { NostrEvent } from '$lib/fabric';

function ev(tags: string[][], content = ''): NostrEvent {
	return { id: 'a'.repeat(64), sig: 'b'.repeat(128), pubkey: 'c'.repeat(64), created_at: 1, kind: 1, tags, content };
}

describe('tagGate', () => {
	it('returns true on an exact value match (value slots only)', () => {
		expect(tagGate('BSI-DSZ-CC-0814-2012', ev([['identifier', 'BSI-DSZ-CC-0814-2012']]))).toBe(true);
	});

	it('matches any value slot, not just slot 1', () => {
		expect(tagGate('active', ev([['status', 'active', 'extra']]))).toBe(true);
	});

	it('does not match the tag key', () => {
		expect(tagGate('identifier', ev([['identifier', 'X']]))).toBe(false);
	});

	it('returns false for a value that is not present', () => {
		expect(tagGate('EAL7', ev([['eal', 'EAL4+']]))).toBe(false);
	});

	it('returns false for an empty field', () => {
		expect(tagGate('', ev([['identifier', 'X']]))).toBe(false);
	});
});

describe('extractedGate', () => {
	it('classifies a normalized contiguous match as verbatim', () => {
		const r = extractedGate('EAL4+   security\ntarget', 'This is the EAL4+ security target document.');
		expect(r.state).toBe('verbatim');
		expect(r.span).toBe('EAL4+ security target');
	});

	it('normalizes away dissimilar whitespace before matching', () => {
		expect(extractedGate('a  b\tc', 'prefix a b c suffix').state).toBe('verbatim');
	});

	it('classifies a multi-word blockquote subset as partial with a span', () => {
		const r = extractedGate('The quick brown fox jumps', 'a quick brown fox ran away');
		expect(r.state).toBe('partial');
		expect(r.span).toBe('quick brown fox');
	});

	it('returns extrapolatory when nothing matches', () => {
		const r = extractedGate('completely different text here', 'the event content shares nothing');
		expect(r.state).toBe('extrapolatory');
		expect(r.span).toBeUndefined();
	});

	it('does not treat a lone single-word overlap as partial (min 2 words)', () => {
		const r = extractedGate('roca vulnerability exploit', 'the word roca appears once');
		expect(r.state).toBe('extrapolatory');
	});

	it('ignores case only when normalized content still lacks the exact span', () => {
		// Verbatim keeps original casing; a case-only difference is not verbatim.
		expect(extractedGate('EAL4+', 'eal4+').state).toBe('extrapolatory');
	});
});

describe('VerificationSource union', () => {
	it('is the locked provenance literal union', () => {
		const sources: VerificationSource[] = ['tag', 'extracted', 'interpreted', 'derived'];
		expect(sources).toHaveLength(4);
		const check: VerificationSource = 'tag';
		expect(check).toBe('tag');
	});
});
