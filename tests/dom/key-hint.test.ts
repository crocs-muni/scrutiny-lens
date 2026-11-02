// KeyHint behaviour (issue #39), rendered for real in jsdom through the
// call shapes the app uses. Replaces the source-text pins that
// term-tooltips.test.ts held: those passed whatever the DOM did.
//
// jsdom runs no layout: getBoundingClientRect/scrollWidth are all 0, so
// "the long value wraps at 20rem" and "the tooltip stays in the viewport"
// cannot be measured here. The wrap test asserts the full text is in the
// DOM and that the wrap classes (not clip classes) are on the surface;
// pixels stay with the browser check AGENTS.md already asks for.

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Harness from './Harness.svelte';

const hover = async (el: HTMLElement) => {
	await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
	await fireEvent.pointerMove(el, { pointerType: 'mouse' });
};

describe('KeyHint tooltip', () => {
	it('opens on keyboard focus with label and keycap, role=tooltip', async () => {
		render(Harness, { variant: 'icon' });
		const trigger = screen.getByRole('button', { name: 'Chat column' });
		expect(screen.queryByRole('tooltip')).toBeNull();

		trigger.focus();
		const tip = await screen.findByRole('tooltip');
		expect(tip.textContent).toContain('Chat column');
		expect(tip.querySelector('kbd')?.textContent).toBe('Ctrl+.');
	});

	it('opens on hover', async () => {
		render(Harness, { variant: 'icon' });
		await hover(screen.getByRole('button', { name: 'Chat column' }));
		expect((await screen.findByRole('tooltip')).textContent).toContain('Chat column');
	});

	it('Escape closes it and focus stays on the trigger (SC 1.4.13)', async () => {
		render(Harness, { variant: 'icon' });
		const trigger = screen.getByRole('button', { name: 'Chat column' });
		trigger.focus();
		await screen.findByRole('tooltip');

		await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	it('icon-only trigger: aria-label is the label alone, keys go to aria-keyshortcuts', async () => {
		render(Harness, { variant: 'icon' });
		const trigger = screen.getByRole('button');
		expect(trigger.getAttribute('aria-label')).toBe('Chat column');
		expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Control+.');

		trigger.focus();
		await screen.findByRole('tooltip');
		// the name already says it: no second announcement through describedby
		expect(trigger.hasAttribute('aria-describedby')).toBe(false);
	});

	it('trigger with visible text: no aria-label, tooltip stays a description', async () => {
		render(Harness, { variant: 'text' });
		const trigger = screen.getByRole('button', { name: 'Scrutiny Lens' });
		expect(trigger.hasAttribute('aria-label')).toBe(false);

		trigger.focus();
		const tip = await screen.findByRole('tooltip');
		expect(tip.textContent).toContain('Home');
		expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
	});

	it('a long machine value renders complete, with wrap classes and no clip classes', async () => {
		const value = 'npub1' + 'q'.repeat(60) + ' ' + 'f'.repeat(400);
		render(Harness, { variant: 'value', value });
		screen.getByRole('button').focus();

		const tip = await screen.findByRole('tooltip');
		expect(tip.textContent?.trim()).toBe(value);
		const cls = tip.className;
		expect(cls).toContain('whitespace-normal');
		expect(cls).toContain('break-words');
		expect(cls).toMatch(/max-w-\[min\(20rem,/);
		expect(cls).not.toMatch(/truncate|whitespace-nowrap|overflow-hidden|max-h-/);
		const machine = tip.querySelector('span');
		expect(machine?.className).toContain('font-mono');
		expect(machine?.className).toContain('break-all');
	});

	it('wrapping an existing element never nests interactive elements', () => {
		const shapes = ['icon', 'text', 'link', 'hover-only', 'share'] as const;
		for (const variant of shapes) {
			const { container, unmount } = render(Harness, { variant });
			expect(
				container.querySelectorAll('button button, a button, button a, a a').length,
				`${variant} nests interactive elements`
			).toBe(0);
			unmount();
		}
	});

	it('a span trigger inside a button keeps role/tabindex and gets no type attribute', async () => {
		render(Harness, { variant: 'span' });
		const retry = screen.getByRole('button', { name: 'Retry' });
		expect(retry.tagName).toBe('SPAN');
		expect(retry.getAttribute('tabindex')).toBe('0');
		expect(retry.hasAttribute('type')).toBe(false);

		retry.focus();
		expect((await screen.findByRole('tooltip')).textContent).toContain('Retry');
	});

	it('a link trigger stays a link (no type attribute) and is described by the tooltip', async () => {
		render(Harness, { variant: 'link' });
		const link = screen.getByRole('link', { name: 'Open' });
		expect(link.hasAttribute('type')).toBe(false);
		link.focus();
		const tip = await screen.findByRole('tooltip');
		expect(link.getAttribute('aria-describedby')).toBe(tip.id);
	});

	it('hover-only child: not a tab stop, no describedby, still opens on hover', async () => {
		render(Harness, { variant: 'hover-only' });
		const el = screen.getByText('3 metadata');
		expect(el.hasAttribute('tabindex')).toBe(false);

		await hover(el);
		const tip = await screen.findByRole('tooltip');
		expect(tip.textContent).toContain('Records bound to this record');
		expect(el.hasAttribute('aria-describedby')).toBe(false);
	});

	it('a disabled trigger stays disabled and shows no tooltip on hover', async () => {
		render(Harness, { variant: 'disabled' });
		const btn = screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		await hover(btn);
		await new Promise((r) => setTimeout(r, 30));
		expect(screen.queryByRole('tooltip')).toBeNull();
	});
});

describe('KeyHint composed with a Popover trigger (SharePopover)', () => {
	it('is one button: tooltip on focus, popover on click, tooltip yields', async () => {
		const { container } = render(Harness, { variant: 'share' });
		expect(container.querySelectorAll('button')).toHaveLength(1);
		const trigger = screen.getByRole('button', { name: 'Share this record' });

		trigger.focus();
		expect((await screen.findByRole('tooltip')).textContent).toContain('Share this record');

		await fireEvent.click(trigger);
		await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
	});
});
