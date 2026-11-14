import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChatRichText, { type RichPart } from '$lib/components/chat/ChatRichText.svelte';
import { layoutAnswer } from '$lib/chat/answer';

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

	it('renders two paragraphs, a table and a citation Sources line together', () => {
		const content = 'First paragraph.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nSources: [1]';
		const parts = layoutAnswer(content, [{ n: 1, verified: true }]);
		const citations = [{ n: 1, eventId: 'e1', quote: 'q', colorIndex: 0 }];
		render(ChatRichText, { parts, citations });
		expect(screen.getByText('First paragraph.')).toBeTruthy();
		expect(screen.getByRole('table')).toBeTruthy();
		expect(screen.getByRole('button', { name: /Citation 1/ })).toBeTruthy();
	});
});
