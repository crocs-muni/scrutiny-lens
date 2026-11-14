// In-app step stack (issue #142): Results is the section label, the question
// is the Results page, the card is the graph anchor, and the chevron pops one
// anchor-history frame or lands on Results. Pure derivation — the shell
// singleton and the investigation are inputs, never read from here.

import { describe, expect, it } from 'vitest';
import { deriveNavTrail } from '../src/lib/nav';

const input = (over: Partial<Parameters<typeof deriveNavTrail>[0]> = {}) => ({
	view: 'session' as const,
	sessionTitle: 'Which ROCA keys are still certified?',
	subjectTitle: null,
	subjectMono: false,
	previousAnchorTitle: null,
	...over
});

describe('deriveNavTrail', () => {
	it('has no bar outside the step stack (search)', () => {
		expect(deriveNavTrail(input({ view: 'search' }))).toBeNull();
	});

	it('results: section label + the question as the current Results page', () => {
		const trail = deriveNavTrail(input({ view: 'results' }))!;
		expect(trail.rootLabel).toBe('Results');
		expect(
			trail.crumbs.map((c) => [c.level, c.label, c.action, c.current, c.mono])
		).toEqual([['session', 'Which ROCA keys are still certified?', null, true, false]]);
		expect(trail.up).toBeNull();
		expect(trail.upLabel).toBe('');
		expect(trail.live).toBe('At Which ROCA keys are still certified?');
	});

	it('session root: the question is current; the chevron returns to results', () => {
		const trail = deriveNavTrail(input())!;
		expect(trail.rootLabel).toBe('Results');
		expect(trail.crumbs.map((c) => [c.level, c.action, c.current])).toEqual([
			['session', null, true]
		]);
		expect(trail.up).toBe('results');
		expect(trail.upLabel).toBe('Back to results');
		expect(trail.live).toBe('At Which ROCA keys are still certified?; Back to results');
	});

	it('session + anchor: the question opens Results; the card is current', () => {
		const trail = deriveNavTrail(input({ subjectTitle: 'Athena IDProtect' }))!;
		expect(
			trail.crumbs.map((c) => [c.level, c.label, c.action, c.current, c.mono])
		).toEqual([
			['session', 'Which ROCA keys are still certified?', 'results', false, false],
			['subject', 'Athena IDProtect', null, true, false]
		]);
		expect(trail.up).toBe('results');
		expect(trail.upLabel).toBe('Back to results');
	});

	it('a previous anchor is the chevron target and its title is the label', () => {
		const trail = deriveNavTrail(
			input({ subjectTitle: 'Athena IDProtect', previousAnchorTitle: 'NXP JCOP' })
		)!;
		expect(trail.up).toBe('previous-anchor');
		expect(trail.upLabel).toBe('Back to NXP JCOP');
		expect(trail.live).toBe('At Athena IDProtect; Back to NXP JCOP');
	});

	it('a machine-made anchor title is marked mono', () => {
		const trail = deriveNavTrail(input({ subjectTitle: 'cc:…', subjectMono: true }))!;
		expect(trail.crumbs[1].mono).toBe(true);
	});

	it('results never grows a card crumb, even with a live anchor', () => {
		const trail = deriveNavTrail(
			input({ view: 'results', subjectTitle: 'Athena IDProtect', previousAnchorTitle: 'NXP JCOP' })
		)!;
		expect(trail.crumbs.map((c) => c.level)).toEqual(['session']);
		expect(trail.up).toBeNull();
	});

	it('blank titles never produce an empty crumb or a dead Results row', () => {
		const withoutSession = deriveNavTrail(input({ sessionTitle: null }))!;
		expect(withoutSession.crumbs.map((c) => [c.label, c.current])).toEqual([
			['Untitled session', true]
		]);
		expect(withoutSession.up).toBe('results');

		const blankSession = deriveNavTrail(input({ sessionTitle: '   ' }))!;
		expect(blankSession.crumbs[0].label).toBe('Untitled session');

		const blankSubject = deriveNavTrail(input({ subjectTitle: '   ' }))!;
		expect(blankSubject.crumbs.map((c) => c.level)).toEqual(['session']);
		expect(blankSubject.up).toBe('results');

		const blankPrevious = deriveNavTrail(
			input({ subjectTitle: 'Athena', previousAnchorTitle: '   ' })
		)!;
		expect(blankPrevious.up).toBe('results');
		expect(blankPrevious.upLabel).toBe('Back to results');
	});

	it('trims every label it renders', () => {
		const trail = deriveNavTrail(
			input({
				sessionTitle: '  ROCA  ',
				subjectTitle: '  Athena  ',
				previousAnchorTitle: '  Previous  '
			})
		)!;
		expect(trail.crumbs.map((c) => c.label)).toEqual(['ROCA', 'Athena']);
		expect(trail.upLabel).toBe('Back to Previous');
	});
});
