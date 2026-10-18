// Results-surface fill banner (spec §2 never-lie, §6 deterministic wording):
// the zero-fill text must reflect WHY the fill failed. A dead endpoint
// (unreachable/timeout) says "Endpoint unreachable", but an endpoint that
// answered and produced non-conforming output (schema_failure) — or answered
// 429, throttling us (rate_limited) — must NOT be labeled unreachable: that
// is the owner's incident. User-visible text speaks issue #108's raw/filled
// vocabulary — never "AI" or "interpreted".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	fillNote,
	investigation,
	recordFillFailure,
	resetInvestigation,
} from '../src/lib/investigation.svelte';
import type { SearchSession } from '../src/lib/pipeline';
import type { AIKind } from '../src/lib/ai/output';

describe('fillNote — says the truth about why cards stayed raw', () => {
	it('endpoint answered but every fill failed schema → not "unreachable"', () => {
		const note = fillNote(0, 5, 'schema_failure');
		expect(note).toBe("Output didn't conform — cards show the raw events");
		expect(note).not.toContain('unreachable');
	});

	it('endpoint unreachable → still "Endpoint unreachable"', () => {
		expect(fillNote(0, 5, 'unreachable')).toBe('Endpoint unreachable — cards show the raw events');
		expect(fillNote(0, 5, 'timeout')).toBe('Endpoint unreachable — cards show the raw events');
	});

	it('browser blocked the request (CORS/mixed content) → names the browser, not "unreachable"', () => {
		const note = fillNote(0, 5, 'browser_blocked');
		expect(note).toBe(
			'Endpoint blocked by the browser (CORS or mixed content) — cards show the raw events'
		);
		expect(note).not.toContain('unreachable');
	});

	it('endpoint answered 429 (throttled) → names rate limiting, not "unreachable"', () => {
		const note = fillNote(0, 5, 'rate_limited');
		expect(note).toBe('Endpoint rate limited — cards show the raw events');
		expect(note).not.toContain('unreachable');
	});

	it('appends the endpoint-stated 429 count when the run saw any (#105)', () => {
		// The count is what the gateway actually SAW this run (spec §2),
		// carried as a trailing suffix so a wording pass (#108, landed) can
		// rewrite the head sentence without touching the count.
		expect(fillNote(0, 5, 'rate_limited', null, 2)).toBe(
			'Endpoint rate limited — cards show the raw events · endpoint rate limited 2×'
		);
		// Zero means the retries cleared everything — the bare sentence
		// already says what happened, no suffix.
		expect(fillNote(0, 5, 'rate_limited', null, 0)).toBe(
			'Endpoint rate limited — cards show the raw events'
		);
		expect(fillNote(0, 5, 'rate_limited')).toBe(
			'Endpoint rate limited — cards show the raw events'
		);
	});

	it('partial fill stays numeric and never "broken"', () => {
		expect(fillNote(2, 5, 'schema_failure')).toBe(
			'Slow — 2 of 5 cards filled · the rest show the raw events'
		);
	});

	it('full fill or no cards → no banner', () => {
		expect(fillNote(5, 5, 'schema_failure')).toBe('');
		expect(fillNote(0, 0, 'schema_failure')).toBe('');
	});

	it('names the concrete reason next to the class (PR #50 lane)', () => {
		expect(fillNote(0, 5, 'unreachable', 'fetch failed with status 503')).toBe(
			'Endpoint unreachable (fetch failed with status 503) — cards show the raw events'
		);
		expect(fillNote(0, 5, 'schema_failure', 'zod: id missing on card 3')).toBe(
			"Output didn't conform (zod: id missing on card 3) — cards show the raw events"
		);
		// Empty/absent reasons keep the bare sentence (no dangling parens).
		expect(fillNote(0, 5, 'unreachable', '')).toBe('Endpoint unreachable — cards show the raw events');
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

// issue #85 (spec §9 glossary): selecting another PRODUCT while on the
// session surface re-anchors the subject graph on it; a metadata selection
// moves only the ring + dossier. The classification is core's own
// scrutinyEventType — the same t-tag predicate deriveSubjectGraph gates on —
// so these events carry only the t tags the classifier reads.
describe('selectSubject — product re-anchor (issue #85, spec §9)', () => {
	const event = (id: string, type: 'scrutiny-product' | 'scrutiny-metadata') => ({
		id,
		kind: 1,
		created_at: 1_780_000_000,
		content: '',
		sig: '',
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-v0.8.1'],
			['t', type],
		],
	});
	const session = (admitted: unknown[]): SearchSession =>
		({
			searches: [],
			admitted,
			invalidSkipped: 0,
			notices: [],
			relays: [],
		}) as unknown as SearchSession;

	beforeEach(() => resetInvestigation());
	afterEach(() => resetInvestigation());

	it('first product selection anchors the graph', () => {
		investigation.result = session([event('p1', 'scrutiny-product')]);
		investigation.selectSubject('p1');
		expect(investigation.graphSubjectId).toBe('p1');
		expect(investigation.selectedEventId).toBe('p1');
	});

	it('a second product selection re-anchors on it', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('p2', 'scrutiny-product'),
		]);
		investigation.selectSubject('p1');
		investigation.selectSubject('p2');
		expect(investigation.graphSubjectId).toBe('p2');
		expect(investigation.selectedEventId).toBe('p2');
	});

	it('a metadata selection never moves the anchor (ring + dossier only)', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('m1', 'scrutiny-metadata'),
		]);
		investigation.selectSubject('p1');
		investigation.selectSubject('m1');
		// The dossier follows the click; the graph stays anchored on p1.
		expect(investigation.selectedEventId).toBe('m1');
		expect(investigation.graphSubjectId).toBe('p1');
	});

	it('a metadata-first session still gets a subject graph (#29b ruling 4)', () => {
		investigation.result = session([event('m1', 'scrutiny-metadata')]);
		investigation.selectSubject('m1');
		expect(investigation.graphSubjectId).toBe('m1');
	});

	it('an event outside the admitted set keeps the old first-subject rule (never anchors on a guess)', () => {
		investigation.result = session([event('p1', 'scrutiny-product')]);
		// Unknown kind: the anchor is only filled when still empty.
		investigation.selectSubject('ghost');
		expect(investigation.graphSubjectId).toBe('ghost');
		investigation.selectSubject('lone-product');
		expect(investigation.graphSubjectId).toBe('ghost');
	});

	it('expansion state clears on re-anchor and survives a same-anchor repeat', () => {
		investigation.result = session([
			event('p1', 'scrutiny-product'),
			event('p2', 'scrutiny-product'),
		]);
		investigation.selectSubject('p1');
		investigation.expandRelated('r1');
		investigation.expandBridge('b1');
		expect(investigation.expandedRelated).toEqual(['r1']);
		expect(investigation.expandedBridges).toEqual(['b1']);
		expect(investigation.expansionLog).toEqual(['related', 'bridge']);

		// Re-clicking the SAME anchor is not a swap — the neighborhood survives.
		investigation.selectSubject('p1');
		expect(investigation.expandedRelated).toEqual(['r1']);
		expect(investigation.expandedBridges).toEqual(['b1']);
		expect(investigation.expansionLog).toEqual(['related', 'bridge']);

		// A real swap drops the old anchor's neighborhood (#29b ruling 8, #97).
		investigation.selectSubject('p2');
		expect(investigation.graphSubjectId).toBe('p2');
		expect(investigation.expandedRelated).toEqual([]);
		expect(investigation.expandedBridges).toEqual([]);
		expect(investigation.expansionLog).toEqual([]);
	});
});
