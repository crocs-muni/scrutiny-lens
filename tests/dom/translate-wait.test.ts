// Translate-stage waiting block (issue #91): the rail's only blank stage must
// say it is working, with an elapsed timer, without turning the live region
// into a metronome.

import { render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TranslateWait from '$lib/components/ui/TranslateWait.svelte';

afterEach(() => {
	vi.useRealTimers();
});

describe('translate waiting block (#91)', () => {
	it('announces one stable label and keeps the timer out of the live region', () => {
		vi.useFakeTimers();
		const { container } = render(TranslateWait);

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent?.trim()).toBe('Translating your question…');

		// The ticking timer must never be announced: it re-renders every second.
		const timer = [...container.querySelectorAll('span')].find((s) => /^\d+s$/.test(s.textContent?.trim() ?? ''));
		expect(timer).toBeTruthy();
		expect(timer?.getAttribute('aria-hidden')).toBe('true');
		// The pixel grid is decoration.
		const grid = container.querySelector('[aria-hidden="true"] .grid, [aria-hidden="true"].grid');
		expect(grid ?? container.querySelector('.grid')?.closest('[aria-hidden="true"]')).toBeTruthy();
	});

	it('ticks without re-announcing, then says once that a cold call is slow', async () => {
		vi.useFakeTimers();
		render(TranslateWait);

		await vi.advanceTimersByTimeAsync(3000);
		expect(screen.getByRole('status').textContent?.trim()).toBe('Translating your question…');
		expect(screen.getByText('3s')).toBeTruthy();

		// The one update in the whole wait, at 30s.
		await vi.advanceTimersByTimeAsync(28_000);
		expect(screen.getByRole('status').textContent).toContain('Still translating');
		expect(screen.getByText('31s')).toBeTruthy();

		// Nothing further changes: the label is stable from here on.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(screen.getByRole('status').textContent).toContain('Still translating');
		expect(screen.getByText('41s')).toBeTruthy();
	});

	it('formats a minute and beyond', async () => {
		vi.useFakeTimers();
		render(TranslateWait);
		await vi.advanceTimersByTimeAsync(65_000);
		expect(screen.getByText('1m 5s')).toBeTruthy();
	});
});
