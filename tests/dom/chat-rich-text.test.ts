import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatRichText, { type RichPart } from '$lib/components/chat/ChatRichText.svelte';

/* The renderer's block pass (issue #177): a multi-paragraph run must not
 * duplicate a keyed block, and a GFM table must become a real table. */

describe('ChatRichText — block rendering', () => {
	it('renders multiple paragraphs without the duplicate-key crash', () => {
		const parts: RichPart[] = [{ kind: 'text', text: 'first\n\nsecond', marks: [] }];
		render(ChatRichText, { parts });
		expect(screen.getByText('first')).toBeTruthy();
		expect(screen.getByText('second')).toBeTruthy();
	});

	it('renders a GFM table with header, rows and cell HTML', () => {
		const text =
			'Comparison\n\n| Claim | Observed | Verdict |\n| :--- | :---: | ---: |\n| JavaCard | 2.2.2 | match |\n| **RSA** | `supported` | match |';
		const parts: RichPart[] = [{ kind: 'text', text, marks: [] }];
		render(ChatRichText, { parts });

		const table = screen.getByRole('table');
		expect(table).toBeTruthy();
		expect(screen.getByRole('columnheader', { name: 'Claim' })).toBeTruthy();
		expect(screen.getByRole('cell', { name: 'JavaCard' })).toBeTruthy();
		expect(screen.getByRole('cell', { name: 'supported' })).toBeTruthy();
		expect(screen.getByText('RSA').tagName).toBe('STRONG');
	});
});
