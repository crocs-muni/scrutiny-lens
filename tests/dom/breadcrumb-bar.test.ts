// Breadcrumb bar behaviour (issue #142), rendered for real in jsdom.
// jsdom runs no layout, so truncation is asserted structurally (the
// truncate + min-width classes and the complete label in the DOM) — pixels
// stay with the browser check. Hover/underline affordances are class-level,
// not measured.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import BreadcrumbHarness from './BreadcrumbHarness.svelte';
import type { NavCrumb } from '$lib/nav';

const crumb = (over: Partial<NavCrumb> & Pick<NavCrumb, 'level' | 'label'>): NavCrumb => ({
	action: null,
	current: false,
	mono: false,
	...over
});

const RESULTS: NavCrumb[] = [
	crumb({ level: 'session', label: 'Which ROCA keys still ship?', current: true })
];
const SESSION_ROOT = RESULTS;
const SUBJECT = [
	crumb({ level: 'session', label: 'Which ROCA keys still ship?', action: 'results' }),
	crumb({ level: 'subject', label: 'Athena IDProtect', current: true })
];

/** jsdom has no layout; make the long labels report as clipped so the
 * truncation action can exercise the tooltip branch. */
function stubClipped(long: string): () => void {
	const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
	const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
	Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
		configurable: true,
		get(this: HTMLElement) {
			return this.textContent?.includes(long) ? 500 : 0;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get(this: HTMLElement) {
			return this.textContent?.includes(long) ? 120 : 0;
		}
	});
	return () => {
		if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
		if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
	};
}

describe('BreadcrumbBar', () => {
	it('results root: Results is a section label; the question is current, not a button', () => {
		render(BreadcrumbHarness, { crumbs: RESULTS, up: null });
		const bar = screen.getByRole('navigation', { name: 'Breadcrumb' });
		expect(bar).toBeTruthy();
		expect(document.querySelector('ol')).toBeTruthy();
		expect(within(bar).getByText('Results')).toBeTruthy();
		expect(within(bar).queryByRole('button')).toBeNull();
		// The section label is outside the breadcrumb list.
		expect(within(bar).getByText('Results').closest('ol')).toBeNull();

		const current = document.querySelector('[aria-current="page"]')!;
		expect(current.textContent?.trim()).toBe('Which ROCA keys still ship?');
		expect(current.tagName).toBe('SPAN');
		// Text, not a control: no tab stop and no programmatic focus target.
		expect(current.hasAttribute('tabindex')).toBe(false);
	});

	it('session root: the chevron returns to results; Results is not a dead button', async () => {
		render(BreadcrumbHarness, { crumbs: SESSION_ROOT, up: 'results' });
		const back = screen.getByRole('button', { name: 'Back to results' });
		expect(back.getAttribute('aria-label')).toBe('Back to results');
		expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
		expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'Results' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Which ROCA keys still ship?' })).toBeNull();

		await fireEvent.click(back);
		expect(screen.getByTestId('events').textContent).toBe('ascend:results');
	});

	it('anchor level: the question opens Results; the card is current', async () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'results' });
		expect(screen.getByRole('button', { name: 'Back to results' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Which ROCA keys still ship?' }));
		expect(screen.getByTestId('events').textContent).toBe('crumb:results');

		const current = document.querySelector('[aria-current="page"]')!;
		expect(current.textContent?.trim()).toBe('Athena IDProtect');
		expect(current.closest('li')?.className).toContain('flex-1');
	});

	it('previous anchor: the chevron names and returns to the previous card', async () => {
		render(BreadcrumbHarness, {
			crumbs: SUBJECT,
			up: 'previous-anchor',
			upLabel: 'Back to NXP JCOP'
		});
		const back = screen.getByRole('button', { name: 'Back to NXP JCOP' });
		await fireEvent.click(back);
		expect(screen.getByTestId('events').textContent).toBe('ascend:previous-anchor');
	});

	it('a full label keeps its text in the DOM without an always-on tooltip', () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'results' });
		const trigger = screen.getByRole('button', { name: 'Which ROCA keys still ship?' });
		trigger.focus();
		expect(screen.queryByRole('tooltip')).toBeNull();
	});

	it('clipped labels keep the complete text and expose it as a tooltip', async () => {
		const long = 'A'.repeat(140);
		const restore = stubClipped(long);
		try {
			const crumbs = [
				crumb({ level: 'session', label: long, action: 'results' }),
				crumb({ level: 'subject', label: long + ' subject', current: true })
			];
			render(BreadcrumbHarness, { crumbs, up: 'previous-anchor' });

			const trigger = screen.getByRole('button', { name: long });
			expect(trigger.className).toContain('truncate');
			expect(trigger.className).toContain('min-w-[6ch]');
			const current = document.querySelector('[aria-current="page"]')!;
			expect(current.className).toContain('truncate');
			expect(current.className).toContain('min-w-[8ch]');
			// Clipped text is complete in the DOM: the tip is a supplement, not
			// a second announcement.
			expect(trigger.hasAttribute('aria-describedby')).toBe(false);

			trigger.focus();
			const tip = await screen.findByRole('tooltip');
			expect(tip.textContent).toContain(long);
		} finally {
			restore();
		}
	});

	it('the bar stays inert: no transition or animation classes', () => {
		render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'results' });
		const bar = screen.getByRole('navigation', { name: 'Breadcrumb' });
		for (const el of [bar, ...bar.querySelectorAll('*')]) {
			expect(el.className.toString()).not.toContain('transition');
			expect(el.className.toString()).not.toContain('animate');
		}
	});

	it('a machine-made card title renders in mono', () => {
		render(BreadcrumbHarness, {
			crumbs: [
				crumb({ level: 'session', label: 'Which ROCA keys still ship?', action: 'results' }),
				crumb({ level: 'subject', label: 'cc:…', current: true, mono: true })
			],
			up: 'results'
		});
		const current = document.querySelector('[aria-current="page"]')!;
		expect(current.className).toContain('font-mono');
		expect(current.className).toContain('text-[11.5px]');
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

	it('announces the changed trail politely', () => {
		render(BreadcrumbHarness, {
			crumbs: SUBJECT,
			up: 'results',
			live: 'At Athena IDProtect; Back to results'
		});
		const live = document.querySelector('[aria-live="polite"]')!;
		expect(live.textContent).toContain('At Athena IDProtect; Back to results');
	});

	it('focusAfterAscend() lands on the next back control, else the bar itself', async () => {
		const { unmount } = render(BreadcrumbHarness, { crumbs: SUBJECT, up: 'results' });
		await fireEvent.click(screen.getByTestId('focus-ascend'));
		expect(document.activeElement?.getAttribute('data-focus-back')).not.toBeNull();
		expect(document.activeElement?.getAttribute('aria-label')).toBe('Back to results');
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
		const long = 'A'.repeat(140);
		const restore = stubClipped(long);
		try {
			const crumbs = [
				crumb({ level: 'session', label: long, action: 'results' }),
				crumb({ level: 'subject', label: long + ' subject', current: true })
			];
			render(BreadcrumbHarness, { crumbs, up: 'results' });
			const trigger = screen.getByRole('button', { name: long });
			trigger.focus();
			await screen.findByRole('tooltip');

			await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
			await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
			expect(document.activeElement).toBe(trigger);
		} finally {
			restore();
		}
	});
});
