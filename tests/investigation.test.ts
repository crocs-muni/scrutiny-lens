// Results-surface fill banner (spec §2 never-lie, §6 deterministic wording):
// the zero-interpreted text must reflect WHY the fill failed. A dead endpoint
// (unreachable/timeout) says "AI unreachable", but an endpoint that answered
// and produced non-conforming output (schema_failure) must NOT be labeled
// unreachable — that is the owner's incident.

import { describe, expect, it } from 'vitest';
import { fillNote } from '../src/lib/investigation.svelte';

describe("fillNote — says the truth about why cards aren't interpreted", () => {
	it('endpoint answered but every fill failed schema → not "unreachable"', () => {
		const note = fillNote(0, 5, 'schema_failure');
		expect(note).toBe("AI output didn't conform — cards show the raw events");
		expect(note).not.toContain('unreachable');
	});

	it('endpoint unreachable → still "AI unreachable"', () => {
		expect(fillNote(0, 5, 'unreachable')).toBe('AI unreachable — cards show the raw events');
		expect(fillNote(0, 5, 'timeout')).toBe('AI unreachable — cards show the raw events');
	});

	it('browser blocked the request (CORS/mixed content) → names the browser, not "unreachable"', () => {
		const note = fillNote(0, 5, 'browser_blocked');
		expect(note).toBe(
			'AI endpoint blocked by the browser (CORS or mixed content) — cards show the raw events'
		);
		expect(note).not.toContain('unreachable');
	});

	it('partial interpretation stays numeric and never "broken"', () => {
		expect(fillNote(2, 5, 'schema_failure')).toBe(
			'AI slow — 2 of 5 cards interpreted · uninterpreted cards show the raw events'
		);
	});

	it('full interpretation or no cards → no banner', () => {
		expect(fillNote(5, 5, 'schema_failure')).toBe('');
		expect(fillNote(0, 0, 'schema_failure')).toBe('');
	});
});
