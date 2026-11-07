// Breadcrumb bar behaviour (issue #142), rendered for real in jsdom.
// jsdom runs no layout, so truncation is asserted structurally (the
// truncate class + the complete label in the DOM) — pixels stay with the
// browser check. Hover/underline affordances are class-level, not measured.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import BreadcrumbHarness from './BreadcrumbHarness.svelte';
import type { NavCrumb } from '$lib/nav';

const crumb = (over: Partial<NavCrumb> & Pick<NavCrumb, 'level' | 'label'>): NavCrumb => ({
	interactive: false,
	current: false,
	...over
});

const RESULTS: NavCrumb[] = [
	crumb({ level: 'results', label: 'Results' }),
	crumb({ level: 'session', label: 'Which ROCA keys still ship?', current: true })
];
const SESSION_ROOT = [crumb({ level: 'results', label: 'Results', interactive: true }), RESULTS[1]];
const SUBJECT = [
	SESSION_ROOT[0],
	crumb({ level: 'session', label: 'Which ROCA keys still ship?', interactive: true }),
	crumb({ level: 'subject', label: 'Athena IDProtect', current: true })
];

describe('BreadcrumbBar', () => {
	it('results root: trail only, no back affordance, current crumb is not a button', () => {
		render(BreadcrumbHarness, { crumbs: RESULTS, up: null });
		const bar = screen.getByRole('navigation', { name: 'Breadcrumb' });
		expect(bar).toBeTruthy();
		expect(document.querySelector('ol')).toBeTruthy();
		expect(within(bar).queryByRole('button')).toBeNull();

		const current = document.querySelector('[aria-current="page"]')!;
		expect(current.textContent?.trim()).toBe('Which ROCA keys still ship?');
		expect(current.tagName).toBe('SPAN');
		// A programmatic focus target, never a tab stop.
		expect(current.getAttribute('tabindex')).toBe('-1');
	});

	it('session root: back chevron names its destination and Results crumb navigates', async () => {
		render(BreadcrumbHarness, { crumbs: SESSION_ROOT, up: 'results' });
		const back = screen.getByRole('button', { name: 'Back to results' });
		expect(back.getAttribute('aria-label')).toBe('Back to results');
		expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

		await fireEvent.click(back);
		expect(screen.getByTestId('events').textContent).toBe('ascend:results');

		await fireEvent.click(screen.getByRole('button', { name: 'Results' }));
		expect(screen.getByTestId('events').textContent).toBe('ascend:results,crumb:results');
	});

	it('subject level: one-level back, session crumb clears the subject, subject is current', async () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'clear-subject' });
		expect(screen.getByRole('button', { name: 'Back to session' })).toBeTruthy();

		await fireEvent.click(
			screen.getByRole('button', { name: 'Which ROCA keys still ship?' })
		);
		expect(screen.getByTestId('events').textContent).toBe('crumb:session');

		const current = document.querySelector('[aria-current="page"]')!;
		expect(current.textContent?.trim()).toBe('Athena IDProtect');
		expect(current.closest('li')?.className).toContain('flex-1');
	});

	it('long titles keep the complete label in the DOM and expose it as a tooltip', async () => {
		const long = 'A'.repeat(140);
		const crumbs = [
			SESSION_ROOT[0],
			crumb({ level: 'session', label: long, interactive: true }),
			crumb({ level: 'subject', label: long + ' subject', current: true })
		];
		render(BreadcrumbHarness, { crumbs, up: 'clear-subject' });

		const trigger = screen.getByRole('button', { name: long });
		expect(trigger.className).toContain('truncate');
		// Clipped text is complete in the DOM: the tip is a supplement, not
		// a second announcement.
		expect(trigger.hasAttribute('aria-describedby')).toBe(false);

		trigger.focus();
		const tip = await screen.findByRole('tooltip');
		expect(tip.textContent).toContain(long);
	});

	it('the bar stays inert: no transition or animation classes', () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'clear-subject' });
		const bar = screen.getByRole('navigation', { name: 'Breadcrumb' });
		for (const el of [bar, ...bar.querySelectorAll('*')]) {
			expect(el.className.toString()).not.toContain('transition');
			expect(el.className.toString()).not.toContain('animate');
		}
	});

	it('renders the results ledger on the right only when given one', () => {
		const { unmount } = render(BreadcrumbHarness, {
			crumbs: RESULTS,
			up: null,
			meta: 'fetched 42 · relays may hold more'
		});
		expect(screen.getByText('fetched 42 · relays may hold more')).toBeTruthy();
		unmount();

		render(BreadcrumbHarness, { crumbs: SESSION_ROOT, up: 'results' });
		expect(screen.queryByText(/fetched/)).toBeNull();
	});

	it('focusAfterAscend() lands on the next back control, else the bar itself', async () => {
		const { unmount } = render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'clear-subject' });
		await fireEvent.click(screen.getByTestId('focus-ascend'));
		expect(document.activeElement?.getAttribute('aria-label')).toBe('Back to session');
		// Focus on the chevron keeps the next Escape clean: no focus tooltip
		// to consume it.
		expect(screen.queryByRole('tooltip')).toBeNull();
		unmount();

		render(BreadcrumbHarness, { crumbs: RESULTS, up: null });
		await fireEvent.click(screen.getByTestId('focus-ascend'));
		// The landmark, not the current crumb: a crumb focus would open its
		// tooltip over the bar for no reason at the trail root.
		expect(document.activeElement).toBe(
			screen.getByRole('navigation', { name: 'Breadcrumb' })
		);
		expect(screen.queryByRole('tooltip')).toBeNull();
	});

	it('tooltip closes on Escape without moving focus (SC 1.4.13)', async () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'clear-subject' });
		const trigger = screen.getByRole('button', { name: 'Which ROCA keys still ship?' });
		trigger.focus();
		await screen.findByRole('tooltip');

		await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});
});
