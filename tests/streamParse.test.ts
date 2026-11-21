// The live surface renders exactly this prefix (issue #30; #134 pill cutover).
// Everything after it can still grow into a marker, so it must stay off
// screen: a half-written payload never renders, not even as a placeholder.

import { describe, it, expect } from 'vitest';
import { readablePrefix } from '$lib/chat/streamParse';

const CLOSED = '[1]{"eventId":"ev1","quote":"q"}';

describe('readablePrefix plain prose', () => {
	it('passes text without markers through whole', () => {
		expect(readablePrefix('just words here')).toBe('just words here');
	});

	it('is empty for the empty string', () => {
		expect(readablePrefix('')).toBe('');
	});
});

describe('readablePrefix complete markers', () => {
	it('keeps a closed marker in the middle of the text', () => {
		const raw = `before ${CLOSED} after`;
		expect(readablePrefix(raw)).toBe(raw);
	});

	it('keeps a marker that ends the stream', () => {
		expect(readablePrefix(`lead ${CLOSED}`)).toBe(`lead ${CLOSED}`);
	});

	it('keeps adjacent markers', () => {
		const raw = `[1]{"eventId":"ev-a","quote":"q1"}[2]{"eventId":"ev-a","quote":"q2"}`;
		expect(readablePrefix(raw)).toBe(raw);
	});

	it('keeps a closed payload even when it is corrupt — the settle gate strips it', () => {
		// Closed is closed: whether it renders is decided by the quote gate
		// (chat/settle.ts), never by this file.
		expect(readablePrefix('[1]{oops}')).toBe('[1]{oops}');
		expect(readablePrefix('[1]{"eventId":5}')).toBe('[1]{"eventId":5}');
	});

	it('reads a payload with nested braces to its real close (PQC regression)', () => {
		const raw = '[2]{"eventId":"x","quote":"Kyber":{"KYBER":1,"N":2}}';
		expect(readablePrefix(raw)).toBe(raw);
	});
});

describe('readablePrefix split-marker (incremental deltas)', () => {
	it('withholds an incomplete tail until the marker completes', () => {
		expect(readablePrefix('abc [1')).toBe('abc ');
		expect(readablePrefix('abc [1]')).toBe('abc ');
		expect(readablePrefix('abc [1]{')).toBe('abc ');
		expect(readablePrefix('abc [1]{"eventId":"ev1","quote":"q"}')).toBe(
			'abc [1]{"eventId":"ev1","quote":"q"}'
		);
	});

	it('withheld literal [1] becomes prose once non-space content breaks it', () => {
		// '[1] ' with only whitespace after is a withheld tail (it could still
		// become a marker).
		expect(readablePrefix('[1] ')).toBe('');
		// Appending ' x' breaks the `\s*` branch: the whole chunk is prose now.
		expect(readablePrefix('[1] x')).toBe('[1] x');
	});

	it('keeps a bare [N] readable when more text follows it', () => {
		// A number the model echoed with no payload can no longer become a
		// marker; settle strips the token, so it never lingers mid-stream.
		expect(readablePrefix('Claim [1] and more text')).toBe('Claim [1] and more text');
	});

	it('digitless brackets such as [x] stay literal prose', () => {
		expect(readablePrefix('[x]')).toBe('[x]');
	});

	it('withholds a bare opening bracket as a tail', () => {
		// The pre-tail space STAYS: already-rendered text must never vanish
		// when the tail starts withholding (no flicker class in the design).
		expect(readablePrefix('abc [')).toBe('abc ');
	});

	it('last opening bracket wins when picking the withheld tail', () => {
		expect(readablePrefix('ref [x] and [12')).toBe('ref [x] and ');
	});

	it('withholds an incomplete tail that trails a complete marker', () => {
		expect(readablePrefix(`talk ${CLOSED} then [2`)).toBe(`talk ${CLOSED} then `);
	});

	it('keeps a half-written object off screen even before its marker closes', () => {
		expect(readablePrefix('[2]{"eventId":"x","quote":"Kyber":{"KYB')).toBe('');
	});
});

describe('readablePrefix monotonicity', () => {
	it('never takes back a character as the stream appends', () => {
		// The stream only appends, so the renderable text can only grow onto
		// the previous one — no flicker, no text re-acquired.
		const full = `First claim ${CLOSED}. Tail [2]{"eventId":"ev1","quote":"q"}`;
		let shown = '';
		for (let i = 0; i <= full.length; i++) {
			const next = readablePrefix(full.slice(0, i));
			expect(next.startsWith(shown)).toBe(true);
			shown = next;
		}
		expect(shown).toBe(full);
	});
});
