import { describe, it, expect } from 'vitest';
import { parseChatStream, type StreamSegment } from '$lib/chat/streamParse';

// Project a segment to a 2-tuple so expectations read compactly:
// ['prose', text] | ['pending', n].
type Seg = ['prose', string] | ['pending', number | null];
const seg = (s: StreamSegment): Seg =>
	s.kind === 'prose' ? ['prose', s.text] : ['pending', s.n];

// A pin spy: records call order (once per complete marker, left to right)
// and returns 1 for 'ev1' (grounded), null otherwise (grounding miss).
function probe() {
	const calls: string[] = [];
	const pin = (id: string): number | null => {
		calls.push(id);
		return id === 'ev1' ? 1 : null;
	};
	// For order-sensitive tests, tiny() returns the call ordinal instead.
	const tiny = (id: string): number | null => {
		calls.push(id);
		return calls.length;
	};
	return { calls, pin, tiny };
}

describe('parseChatStream plain prose', () => {
	it('emits one prose segment for text without markers', () => {
		const { pin } = probe();
		expect(parseChatStream('just words here', pin).map(seg)).toEqual([['prose', 'just words here']]);
	});

	it('emits no segments for the empty string', () => {
		const { pin } = probe();
		expect(parseChatStream('', pin).map(seg)).toEqual([]);
	});
});

describe('parseChatStream complete markers', () => {
	it('splits mid-text marker into prose/pending/prose', () => {
		const { calls, pin } = probe();
		expect(
			parseChatStream('before [7]{"eventId":"ev1","quote":"q"} after', pin).map(seg)
		).toEqual([['prose', 'before '], ['pending', 1], ['prose', ' after']]);
		expect(calls).toEqual(['ev1']);
	});

	it('marker at end yields prose + pending', () => {
		const { pin } = probe();
		expect(
			parseChatStream('lead [4]{"eventId":"ev1","quote":"q"}', pin).map(seg)
		).toEqual([['prose', 'lead '], ['pending', 1]]);
	});

	it('adjacent markers sharing an eventId pin once each, left to right, n from pin not digits', () => {
		// Even though the digits are [1] and [2], both map to eventId 'ev-a':
		// n must come from pin (computed), never from the raw marker digits.
		const { calls, tiny } = probe();
		expect(
			parseChatStream('[1]{"eventId":"ev-a","quote":"q1"}[2]{"eventId":"ev-a","quote":"q2"}', tiny).map(seg)
		).toEqual([['pending', 1], ['pending', 2]]);
		expect(calls).toEqual(['ev-a', 'ev-a']);
	});

	it('keeps prose runs between separate markers as distinct segments', () => {
		const { calls, pin } = probe();
		expect(
			parseChatStream('a [1]{"eventId":"ev1","quote":"q1"} b [2]{"eventId":"absent","quote":"q2"} c', pin).map(seg)
		).toEqual([['prose', 'a '], ['pending', 1], ['prose', ' b '], ['pending', null], ['prose', ' c']]);
		expect(calls).toEqual(['ev1', 'absent']);
	});
});

describe('parseChatStream split-marker (incremental deltas)', () => {
	it('withholds an incomplete tail until the marker completes', () => {
		const { calls, pin } = probe();
		// Each call re-parses the whole accumulated string (stateless).
		expect(parseChatStream('abc [1', pin).map(seg)).toEqual([['prose', 'abc ']]);
		expect(parseChatStream('abc [1]', pin).map(seg)).toEqual([['prose', 'abc ']]);
		expect(parseChatStream('abc [1]{', pin).map(seg)).toEqual([['prose', 'abc ']]);
		// pin must not fire until the marker is complete.
		expect(calls).toEqual([]);
		expect(
			parseChatStream('abc [1]{"eventId":"ev1","quote":"q"}', pin).map(seg)
		).toEqual([['prose', 'abc '], ['pending', 1]]);
		expect(calls).toEqual(['ev1']);
	});

	it('withheld literal [1] becomes prose once non-space content breaks it', () => {
		const { pin } = probe();
		// '[1] ' with only whitespace after is a withheld tail (could still become a marker).
		expect(parseChatStream('[1] ', pin).map(seg)).toEqual([]);
		// Appending ' x' breaks the `\s*` branch: the whole chunk is prose now.
		expect(parseChatStream('[1] x', pin).map(seg)).toEqual([['prose', '[1] x']]);
	});

	it('digitless brackets such as [x] stay literal prose', () => {
		const { pin } = probe();
		expect(parseChatStream('[x]', pin).map(seg)).toEqual([['prose', '[x]']]);
	});

	it('withholds a bare opening bracket as a tail', () => {
		const { pin } = probe();
		// The pre-tail space STAYS: already-rendered text must never vanish
		// when the tail starts withholding (no flicker class in the design).
		expect(parseChatStream('abc [', pin).map(seg)).toEqual([['prose', 'abc ']]);
	});

	it('last opening bracket wins when picking the withheld tail', () => {
		const { pin } = probe();
		expect(parseChatStream('ref [x] and [12', pin).map(seg)).toEqual([['prose', 'ref [x] and ']]);
	});

	it('withholds an incomplete tail that trails a complete marker', () => {
		const { calls, pin } = probe();
		expect(
			parseChatStream('talk [1]{"eventId":"ev1","quote":"q"} then [2', pin).map(seg)
		).toEqual([['prose', 'talk '], ['pending', 1], ['prose', ' then ']]);
		expect(calls).toEqual(['ev1']);
	});
});

describe('parseChatStream payload validation', () => {
	it('malformed payload yields pending null and does not call pin', () => {
		const { calls, pin } = probe();
		expect(parseChatStream('[1]{oops}', pin).map(seg)).toEqual([['pending', null]]);
		expect(calls).toEqual([]);
	});

	it('numeric eventId yields pending null and does not call pin', () => {
		const { calls, pin } = probe();
		expect(parseChatStream('[1]{"eventId":5}', pin).map(seg)).toEqual([['pending', null]]);
		expect(calls).toEqual([]);
	});

	it('empty-string eventId yields pending null and does not call pin', () => {
		const { calls, pin } = probe();
		expect(parseChatStream('[1]{"eventId":"","quote":"q"}', pin).map(seg)).toEqual([['pending', null]]);
		expect(calls).toEqual([]);
	});

	it('missing eventId yields pending null and does not call pin', () => {
		const { calls, pin } = probe();
		expect(parseChatStream('[1]{"quote":"q"}', pin).map(seg)).toEqual([['pending', null]]);
		expect(calls).toEqual([]);
	});

	it('valid payload whose pin is null (grounding miss) yields pending null but still calls pin', () => {
		const { calls, pin } = probe();
		expect(parseChatStream('[1]{"eventId":"absent","quote":"q"}', pin).map(seg)).toEqual([['pending', null]]);
		expect(calls).toEqual(['absent']);
	});
});
