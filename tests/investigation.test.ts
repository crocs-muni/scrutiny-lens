// Results-surface fill banner (spec §2 never-lie, §6 deterministic wording):
// the zero-interpreted text must reflect WHY the fill failed. A dead endpoint
// (unreachable/timeout) says "AI unreachable", but an endpoint that answered
// and produced non-conforming output (schema_failure) — or answered 429,
// throttling us (rate_limited) — must NOT be labeled unreachable: that is the
// owner's incident.

import { describe, expect, it } from 'vitest';
import { fillNote, recordFillFailure } from '../src/lib/investigation.svelte';
import type { AIKind } from '../src/lib/ai/output';

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

	it('endpoint answered 429 (throttled) → names rate limiting, not "unreachable"', () => {
		const note = fillNote(0, 5, 'rate_limited');
		expect(note).toBe('AI endpoint rate limited — cards show the raw events');
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

	it('names the concrete reason next to the class (PR #50 lane)', () => {
		expect(fillNote(0, 5, 'unreachable', 'fetch failed with status 503')).toBe(
			'AI unreachable (fetch failed with status 503) — cards show the raw events'
		);
		expect(fillNote(0, 5, 'schema_failure', 'zod: id missing on card 3')).toBe(
			"AI output didn't conform (zod: id missing on card 3) — cards show the raw events"
		);
		// Empty/absent reasons keep the bare sentence (no dangling parens).
		expect(fillNote(0, 5, 'unreachable', '')).toBe('AI unreachable — cards show the raw events');
	});
});

describe('recordFillFailure — kind and message stay paired under stickiness', () => {
	const state = (): { fillFailure: AIKind | null; fillErrorMessage: string | null } => ({
		fillFailure: null,
		fillErrorMessage: null
	});

	it('schema_failure + its reason win over a later chunk failure', () => {
		const s = state();
		recordFillFailure(s, 'schema_failure', 'zod: id missing on card 3');
		recordFillFailure(s, 'unreachable', 'fetch failed with status 503');
		expect(s.fillFailure).toBe('schema_failure');
		expect(s.fillErrorMessage).toBe('zod: id missing on card 3');
	});

	it('rate_limited is equally sticky (a 429 proves reachability)', () => {
		const s = state();
		recordFillFailure(s, 'rate_limited', 'Retry-After: 15');
		recordFillFailure(s, 'unreachable', 'ECONNRESET');
		expect(s.fillFailure).toBe('rate_limited');
		expect(s.fillErrorMessage).toBe('Retry-After: 15');
	});

	it('first-wins for non-sticky kinds; only the winner pairs the reason', () => {
		const s = state();
		recordFillFailure(s, 'unreachable', 'fetch failed with status 503');
		recordFillFailure(s, 'timeout', 'PER_CHUNK budget exceeded');
		expect(s.fillFailure).toBe('timeout');
		expect(s.fillErrorMessage).toBe('PER_CHUNK budget exceeded');
	});

	it('the reason clips at 140 chars and never carries a key (ADR-018)', () => {
		const s = state();
		recordFillFailure(s, 'unreachable', 'x'.repeat(200) + ' sk-secret-123');
		expect(s.fillErrorMessage).toHaveLength(140);
		expect(s.fillErrorMessage?.endsWith('…')).toBe(true);
		expect(s.fillErrorMessage).not.toContain('sk-secret-123');
	});
});
