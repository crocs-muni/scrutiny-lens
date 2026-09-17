import { describe, it, expect } from 'vitest';
import { scanMarkers } from '$lib/chat/markers';

/* scanMarkers (chat-output rework T1, 2026-09-17): balanced-brace,
 * string-aware marker detection — the flat `[^{}]*` regex leaked a
 * nested-brace PQC payload onto the screen as raw corrupt JSON. */

describe('scanMarkers — the leak class dies', () => {
	it('valid nested-brace payload is scanned whole and extracted', () => {
		const text = `answer line [2]{"eventId":"e1","quote":"Kyber","hits":{"KYBER":1}}`;
		const scans = scanMarkers(text);
		expect(scans).toHaveLength(1);
		expect(scans[0].braced).toBe(true);
		expect(JSON.parse(scans[0].objectText as string)).toEqual({ eventId: 'e1', quote: 'Kyber', hits: { KYBER: 1 } });
	});

	it('balanced-but-INVALID payload (the live PQC leak shape) is braced-but-null — settle strips it, never renders it', () => {
		const text = `answer line [2]{"eventId":"e1","quote":"K"{"X":1}} tail`;
		const scans = scanMarkers(text);
		expect(scans).toHaveLength(1);
		expect(scans[0].braced).toBe(true);
		expect(scans[0].objectText).toBeNull();
	});

	it('braces inside a quoted value do not end the object', () => {
		const text = `[1]{"eventId":"e1","quote":"a } b } still inside"} done`;
		const scans = scanMarkers(text);
		expect(scans[0].objectText).not.toBeNull();
		expect(scans[0].end).toBe(text.indexOf(' done'));
	});

	it('escaped quotes inside strings keep the string running', () => {
		const text = `[1]{"eventId":"e\\"x}","quote":"q"}`;
		const scans = scanMarkers(text);
		expect(scans[0].objectText).not.toBeNull();
	});

	it('bare [N] is reported unbraced (canonical renumber token — never settle-stripped here)', () => {
		const scans = scanMarkers('Claim [1] settled.');
		expect(scans).toEqual([{ start: 6, end: 9, n: 1, objectText: null, braced: false, terminated: true }]);
	});

	it('multiple markers in one stream all report', () => {
		const scans = scanMarkers('a [1]{"eventId":"e1","quote":"q"} b [2]{"eventId":"e2","quote":"p"} end');
		expect(scans.map((s) => s.n)).toEqual([1, 2]);
	});
});
