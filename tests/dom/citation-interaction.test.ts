import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ChatTurn from '$lib/components/chat/ChatTurn.svelte';
import { resetSpotlight } from '$lib/components/chat/spotlight.svelte';
import type { PersistedChatMessage } from '$lib/db';
import type { NostrEvent } from '$lib/fabric';

/* The interaction gate that was missing (issues #184/#185).
 *
 * A citation card used to open on hover and close 180ms after the pointer
 * left the pill, with nothing on the card cancelling the close — so its two
 * buttons could never be pressed (WCAG 2.2 SC 1.4.13 "hoverable", F95). The
 * shipped test suite only proved the pill rendered, which is exactly why a
 * dead affordance shipped.
 *
 * These tests assert the property that was broken, not the implementation:
 * evidence and its actions are reachable by a single click, and no hover
 * timer can take them away. */

const PUB = 'a'.repeat(64);

function ev(id: string, kind: number, tags: string[][]): NostrEvent {
	return {
		id,
		pubkey: PUB,
		created_at: 1_700_000_000,
		kind,
		tags,
		content: `content of ${id}`,
		sig: 's'.repeat(128)
	};
}

const message: PersistedChatMessage = {
	id: 'm1',
	sessionId: 's1',
	role: 'assistant',
	kind: 'answer',
	createdAt: 2,
	content: 'The certificate is current [1] and the advisory was retracted [2].',
	citations: [
		{ n: 1, eventId: 'ev1', quote: 'q1', span: 'span one', nodeTitle: 'ANSSI-CC-2024/19', colorIndex: 0 },
		{ n: 2, eventId: 'ev2', quote: 'q2', span: 'span two', nodeTitle: '2021 advisory', colorIndex: 1 }
	],
	claimsSummary: { total: 2, verbatim: 2, partial: 0, extrapolatory: 0 }
};

const grounding = [ev('ev1', 30023, []), ev('ev2', 30023, []), ev('del1', 5, [['e', 'ev2']])];

function renderTurn(onOpenDossier = vi.fn()) {
	render(ChatTurn, { message, grounding, onOpenDossier });
	return onOpenDossier;
}

describe('chat citation interaction', () => {
	it('shows the source register with no interaction at all', () => {
		resetSpotlight();
		renderTurn();
		expect(screen.getByText('ANSSI-CC-2024/19')).toBeTruthy();
		expect(screen.getByText('2021 advisory')).toBeTruthy();
	});

	it('opens the verified quote on a mark click, and the dossier action fires from there', async () => {
		resetSpotlight();
		const onOpenDossier = renderTurn();
		expect(screen.queryByText('span one')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /Citation 1/ }));
		expect(screen.getByText('span one')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /open dossier/i }));
		expect(onOpenDossier).toHaveBeenCalledWith('ev1');
	});

	it('cannot be closed by a hover timer: the open row is state, not pointer position', async () => {
		vi.useFakeTimers();
		try {
			resetSpotlight();
			renderTurn();
			const mark = screen.getByRole('button', { name: /Citation 1/ });

			await fireEvent.click(mark);
			expect(screen.getByText('span one')).toBeTruthy();

			// The shipped defect, walked exactly: leave the trigger, then dwell
			// past every grace window the old code had.
			await fireEvent.mouseLeave(mark);
			await fireEvent.pointerLeave(mark);
			await vi.advanceTimersByTimeAsync(260);

			expect(screen.getByText('span one')).toBeTruthy();
			expect(screen.getByRole('button', { name: /open dossier/i })).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps one row open at a time, and a second click closes it', async () => {
		resetSpotlight();
		renderTurn();
		const first = screen.getByRole('button', { name: /Citation 1/ });
		const second = screen.getByRole('button', { name: /Citation 2/ });

		await fireEvent.click(first);
		await fireEvent.click(second);
		expect(screen.queryByText('span one')).toBeNull();
		expect(screen.getByText('span two')).toBeTruthy();

		await fireEvent.click(second);
		expect(screen.queryByText('span two')).toBeNull();
	});

	it('marks the protocol status from the admitted set, never from prose', () => {
		resetSpotlight();
		renderTurn();
		// ev2 is targeted by an honoured kind-5 deletion in the grounding set.
		// The answer prose also contains the word, so scope the query to the
		// row the title identifies.
		const row = screen.getByText('2021 advisory').closest('button');
		expect(row).toBeTruthy();
		expect(within(row as HTMLElement).getByText('retracted')).toBeTruthy();
		// The partition is computed, so it appears in the meta line.
		const meta = document.querySelector('.counts');
		expect(meta?.textContent).toBe('2 sources · 1 current · 1 retracted');
	});

	it('says nothing about a partition it cannot compute (record left memory)', async () => {
		resetSpotlight();
		render(ChatTurn, { message, grounding: [], onOpenDossier: vi.fn() });
		const meta = document.querySelector('.counts');
		expect(meta?.textContent).toBe('2 sources');
		expect(meta?.textContent).not.toMatch(/current|retracted/);
	});
});
