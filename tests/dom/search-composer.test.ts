// Hero composer contract (issue #139): the field must read as SEARCH, not as
// chat — one line, a visible label, a search glyph — and a meta question typed
// into it must be caught with guidance instead of becoming a relay text query
// that matches no event (the #164 class).

import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Harness from './SearchComposerHarness.svelte';

function mount() {
	const on_submit = vi.fn();
	const on_settings = vi.fn();
	const { container } = render(Harness, { on_submit, on_settings });
	const field = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;
	return { on_submit, on_settings, container, field };
}

async function typeInto(field: HTMLInputElement, text: string): Promise<void> {
	await fireEvent.input(field, { target: { value: text } });
}

describe('hero composer — search affordance (#139)', () => {
	it('is one line with a visible Search label and a search submit', () => {
		const { field } = mount();
		expect(field.tagName).toBe('INPUT');
		expect(field.getAttribute('type')).toBe('text');
		// Visible to the eye above the bar and the field's accessible name.
		expect(screen.getByText('Search')).toBeTruthy();
		expect(screen.getByRole('button', { name: /^Search/ })).toBeTruthy();
	});

	it('keeps the model picker as a demoted control', () => {
		mount();
		expect(screen.getByRole('button', { name: 'Choose model' })).toBeTruthy();
	});

	it('submits a normal query on Enter', async () => {
		const { on_submit, field } = mount();
		await typeInto(field, 'infineon sle78');
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(on_submit).toHaveBeenCalledWith('infineon sle78');
	});

	it('stops a meta question, explains, and searches it only when asked', async () => {
		const { on_submit, field } = mount();
		await typeInto(field, 'what can you do?');
		await fireEvent.keyDown(field, { key: 'Enter' });
		// Guidance, not a block: nothing was searched yet.
		expect(on_submit).not.toHaveBeenCalled();
		expect(screen.getByText(/question about this app/)).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Search anyway' }));
		expect(on_submit).toHaveBeenCalledWith('what can you do?');
	});

	it('treats an identifier question as a search, never as meta', async () => {
		const { on_submit, field } = mount();
		await typeInto(field, 'what can you tell me about CVE-2017-15361');
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(on_submit).toHaveBeenCalledWith('what can you tell me about CVE-2017-15361');
	});
});
