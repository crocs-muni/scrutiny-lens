import { describe, it, expect } from 'vitest';
import { createCitationRegistry } from '$lib/ai/citationRegistry';
import type { NostrEvent } from '$lib/fabric';

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

const EVENTS = [
	event('ev-alpha', 'Infineon RSA library used in smartcards (ROCA).'),
	event('ev-beta', 'ANSSI-CC-2024/19 M7794 A2 Certificate of product.'),
	event('ev-gamma', 'Maintenance report for the M7794 platform.')
];

describe('createCitationRegistry numbering', () => {
	it('same eventId resolves to the same n (stable)', () => {
		const reg = createCitationRegistry();
		expect(reg.next('ev-alpha')).toBe(1);
		expect(reg.next('ev-alpha')).toBe(1);
		expect(reg.next('ev-alpha')).toBe(1);
	});

	it('new eventIds get the next monotonic number', () => {
		const reg = createCitationRegistry();
		expect(reg.next('ev-alpha')).toBe(1);
		expect(reg.next('ev-beta')).toBe(2);
		expect(reg.next('ev-gamma')).toBe(3);
		expect(reg.next('ev-beta')).toBe(2); // recall, not re-pin
		expect(reg.eventIdFor(3)).toBe('ev-gamma');
		expect(reg.eventIdFor(99)).toBeUndefined();
	});
});

describe('createCitationRegistry resolve', () => {
	it('resolve round-trip: pin by eventId, resolve by [N] back to that eventId', () => {
		const reg = createCitationRegistry();
		expect(reg.next('ev-alpha')).toBe(1);
		const res = reg.resolve('[1]', EVENTS, 'Infineon RSA library used in smartcards (ROCA).');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.citation.n).toBe(1);
		expect(res.citation.eventId).toBe('ev-alpha');
		expect(res.citation.verified).toBe(true);
		expect(res.citation.span).toBe('Infineon RSA library used in smartcards (ROCA).');
	});

	it('out-of-order marker list resolves each [N] to its pinned event regardless of call order', () => {
		const reg = createCitationRegistry();
		reg.next('ev-alpha'); // 1
		reg.next('ev-beta'); // 2
		reg.next('ev-gamma'); // 3

		const third = reg.resolve('[3]', EVENTS, 'Maintenance report for the M7794 platform.');
		const first = reg.resolve('[1]', EVENTS, 'Infineon RSA library used in smartcards (ROCA).');
		const second = reg.resolve(2, EVENTS, 'ANSSI-CC-2024/19 M7794 A2 Certificate of product.');

		for (const r of [third, first, second]) expect(r.ok).toBe(true);
		if (third.ok) expect(third.citation.eventId).toBe('ev-gamma');
		if (first.ok) expect(first.citation.eventId).toBe('ev-alpha');
		if (second.ok) expect(second.citation.eventId).toBe('ev-beta');
	});

	it('resolving an unpinned-but-visible eventId pins it with the next number', () => {
		const reg = createCitationRegistry();
		reg.next('ev-alpha');
		const res = reg.resolve('ev-beta', EVENTS, 'ANSSI-CC-2024/19 M7794 A2 Certificate of product.');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.citation.n).toBe(2);
		// Stable afterwards:
		expect(reg.next('ev-beta')).toBe(2);
	});

	it('unknown eventId → unresolvable', () => {
		const reg = createCitationRegistry();
		const res = reg.resolve('ev-nope', EVENTS, 'anything');
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe('unresolvable');
	});

	it('unknown [N] marker → unresolvable', () => {
		const reg = createCitationRegistry();
		reg.next('ev-alpha');
		const res = reg.resolve('[5]', EVENTS, 'anything');
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe('unresolvable');
	});

	it('[N] pinned to an event absent from the visible list → unresolvable (locked rule)', () => {
		const reg = createCitationRegistry();
		reg.next('ev-elsewhere'); // pinned, but not in EVENTS
		const res = reg.resolve('[1]', EVENTS, 'anything');
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe('unresolvable');
	});
});

describe('createCitationRegistry verification', () => {
	it('verbatim quote → verified with the matched span', () => {
		const reg = createCitationRegistry();
		const res = reg.resolve('ev-alpha', EVENTS, 'Infineon RSA library');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.citation.verified).toBe(true);
		expect(res.citation.span).toBe('Infineon RSA library');
	});

	it('blockquote-subset quote passes as partial → verified with the subset span', () => {
		const reg = createCitationRegistry();
		// Only the trailing run actually appears in the content.
		const res = reg.resolve('ev-alpha', EVENTS, 'According to the card Infineon RSA library used in smartcards');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.citation.verified).toBe(true);
		expect(res.citation.span).toBe('Infineon RSA library used in smartcards');
	});

	it('extrapolatory quote → unverified, no span', () => {
		const reg = createCitationRegistry();
		const res = reg.resolve('ev-alpha', EVENTS, 'completely fabricated sentence about TPMs');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.citation.verified).toBe(false);
		expect(res.citation.span).toBeUndefined();
	});
});
