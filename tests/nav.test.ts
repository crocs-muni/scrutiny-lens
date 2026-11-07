// In-app step stack (issue #142): the trail the bar renders and the
// chevron/Esc ascend target. Pure derivation — the shell singleton and the
// investigation selection are inputs, never read from here.

import { describe, expect, it } from 'vitest';
import { deriveNavTrail } from '../src/lib/nav';

const input = (over: Partial<Parameters<typeof deriveNavTrail>[0]> = {}) => ({
	view: 'session' as const,
	sessionTitle: 'Which ROCA keys are still certified?',
	subjectTitle: null,
	...over
});

describe('deriveNavTrail', () => {
	it('has no bar outside the step stack (search)', () => {
		expect(deriveNavTrail(input({ view: 'search' }))).toBeNull();
	});

	it('results: Results root + session title, no back affordance', () => {
		const trail = deriveNavTrail(input({ view: 'results' }))!;
		expect(trail.crumbs.map((c) => [c.level, c.label, c.interactive, c.current])).toEqual([
			['results', 'Results', false, false],
			['session', 'Which ROCA keys are still certified?', false, true]
		]);
		expect(trail.up).toBeNull();
	});

	it('session root: Results crumb becomes the way back', () => {
		const trail = deriveNavTrail(input())!;
		expect(trail.crumbs.map((c) => [c.level, c.interactive, c.current])).toEqual([
			['results', true, false],
			['session', false, true]
		]);
		expect(trail.up).toBe('results');
	});

	it('session + subject: three levels, subject is current, session clears it', () => {
		const trail = deriveNavTrail(input({ subjectTitle: 'Athena IDProtect' }))!;
		expect(trail.crumbs.map((c) => [c.level, c.label, c.interactive, c.current])).toEqual([
			['results', 'Results', true, false],
			['session', 'Which ROCA keys are still certified?', true, false],
			['subject', 'Athena IDProtect', false, true]
		]);
		expect(trail.up).toBe('clear-subject');
	});

	it('results never grows a subject crumb, even with a live selection', () => {
		const trail = deriveNavTrail(
			input({ view: 'results', subjectTitle: 'Athena IDProtect' })
		)!;
		expect(trail.crumbs.map((c) => c.level)).toEqual(['results', 'session']);
		expect(trail.up).toBeNull();
	});

	it('blank and missing titles never produce an empty crumb', () => {
		const withoutSession = deriveNavTrail(input({ sessionTitle: null }))!;
		expect(withoutSession.crumbs.map((c) => [c.level, c.current])).toEqual([['results', true]]);
		// The one visible crumb is where the user is.
		expect(withoutSession.up).toBe('results');

		const blankSubject = deriveNavTrail(input({ subjectTitle: '   ' }))!;
		expect(blankSubject.crumbs.map((c) => c.level)).toEqual(['results', 'session']);
		expect(blankSubject.up).toBe('results');
	});

	it('trims the labels it renders', () => {
		const trail = deriveNavTrail(
			input({ sessionTitle: '  ROCA  ', subjectTitle: '  Athena  ' })
		)!;
		expect(trail.crumbs.map((c) => c.label)).toEqual(['Results', 'ROCA', 'Athena']);
	});
});
