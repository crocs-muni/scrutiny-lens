import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatMessageFooter from '$lib/components/chat/ChatMessageFooter.svelte';
import CitationPill from '$lib/components/chat/CitationPill.svelte';
import type { SourceRow } from '$lib/chat/turnMeta';
import type { PersistedChatCitation } from '$lib/db';

/* Issue #184 (WCAG 2.2 SC 1.4.13, failure F95): the floating citation card
 * closed 180ms after the pointer left the pill and nothing on the card
 * cancelled the timer, so its actions were unreachable. The replacement is a
 * mark plus an always-visible register; these tests pin the reachability
 * property — every row and action is in the document with no hover at all. */

const sources: SourceRow[] = [
	{
		n: 1,
		eventId: 'event-current',
		title: 'ANSSI-CC-2024/19 certificate',
		quote: 'The certificate is valid through 2029-06-30.',
		colorIndex: 0,
		status: 'current'
	},
	{
		n: 2,
		eventId: 'event-retracted',
		title: '2021 vendor advisory',
		quote: 'Every M7794 revision was affected.',
		colorIndex: 2,
		status: 'retracted'
	}
];

const noop = (): void => {};

const footer = (
	props: {
		openN?: number | null;
		onToggle?: (n: number) => void;
		onOpenDossier?: (eventId: string) => void;
	} = {}
) =>
	render(ChatMessageFooter, {
		content: 'The answer.',
		sources,
		openN: null,
		onToggle: noop,
		onOpenDossier: noop,
		idPrefix: 'm1',
		...props
	});

describe('ChatMessageFooter — always-visible source register', () => {
	it('renders one row per source without any interaction', () => {
		footer();
		expect(screen.getByText('ANSSI-CC-2024/19 certificate')).toBeTruthy();
		expect(screen.getByText('2021 vendor advisory')).toBeTruthy();
	});

	it('chips only the retracted row', () => {
		footer();
		const chips = screen.getAllByText('retracted');
		expect(chips).toHaveLength(1);
		expect(chips[0].closest('button')?.textContent).toContain('2021 vendor advisory');
	});

	it('a row click toggles its quote and never opens the dossier', async () => {
		const onToggle = vi.fn();
		const onOpenDossier = vi.fn();
		footer({ onToggle, onOpenDossier });

		await fireEvent.click(screen.getByRole('button', { name: /ANSSI-CC-2024\/19 certificate/ }));

		expect(onToggle).toHaveBeenCalledWith(1);
		expect(onOpenDossier).not.toHaveBeenCalled();
	});

	it('expands the open row with its verified quote and the dossier action', async () => {
		const onOpenDossier = vi.fn();
		footer({ openN: 1, onOpenDossier });

		expect(screen.getByText('The certificate is valid through 2029-06-30.')).toBeTruthy();
		expect(screen.queryByText('Every M7794 revision was affected.')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /open dossier/i }));

		expect(onOpenDossier).toHaveBeenCalledWith('event-current');
	});

	it('keeps the quote out of the document while no row is open', () => {
		footer();
		expect(screen.queryByText('The certificate is valid through 2029-06-30.')).toBeNull();
	});
});

describe('CitationPill — citation mark', () => {
	const citation: PersistedChatCitation = {
		n: 3,
		eventId: 'event-pill',
		quote: 'verified span',
		nodeTitle: 'Test record',
		colorIndex: 1
	};

	it('reflects the open row through aria-expanded', () => {
		render(CitationPill, { citation, open: false, onToggle: noop });
		render(CitationPill, {
			citation: { ...citation, n: 4, nodeTitle: 'Other record' },
			open: true,
			onToggle: noop
		});

		expect(
			screen.getByRole('button', { name: 'Citation 3: Test record' }).getAttribute('aria-expanded')
		).toBe('false');
		expect(
			screen.getByRole('button', { name: 'Citation 4: Other record' }).getAttribute('aria-expanded')
		).toBe('true');
	});

	it('toggles its citation on click', async () => {
		const onToggle = vi.fn();
		render(CitationPill, { citation, open: false, onToggle });

		await fireEvent.click(screen.getByRole('button', { name: 'Citation 3: Test record' }));

		expect(onToggle).toHaveBeenCalledWith(3);
	});
});
