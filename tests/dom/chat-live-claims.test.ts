// Mid-stream per-claim pills in the DOM (issue #134).
//
// The bug: markers only became parseable at end of stream, so the streaming
// answer read as one undivided claim. The column now settles the readable
// prefix with the transcript's own gate, so each closed claim gets its pill
// as it lands and only the unterminated tail stays plain. Observed through
// the real column while the turn is in flight.

import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ChatColumnHarness from './ChatColumnHarness.svelte';
import { chat, resetChat } from '$lib/chat.svelte';
import type { NostrEvent } from '$lib/fabric';

function event(id: string, content: string): NostrEvent {
	return { id, sig: 'sig', pubkey: 'pk', created_at: 1700000000, kind: 1, tags: [], content };
}

const E1 = event('e1', 'RSA keygen runs in the certified library');
const E2 = event('e2', 'EAL4+ was issued in 2019');
const EVENTS = [E1, E2];

const V1 = 'RSA keygen runs in the certified library';
const V2 = 'EAL4+ was issued in 2019';
const marker = (n: number, eventId: string, quote: string): string =>
	`[${n}]${JSON.stringify({ eventId, quote })}`;

/** Render the column with an in-flight turn at `raw` — the state a reader
 * sees between deltas, with no transcript rows yet. */
function midStream(raw: string): HTMLElement {
	chat.sessionId = 's1';
	chat.grounding = EVENTS;
	chat.live = { question: 'Which library is used?', userId: 'u1', raw };
	return render(ChatColumnHarness).container;
}

/** The streaming answer's block (the question row above it is not prose). */
function answer(container: HTMLElement): string {
	return container.querySelector('.assistant')?.textContent ?? '';
}

beforeEach(() => {
	resetChat();
	// jsdom has no element scrollTo; the column pins the transcript to the
	// newest content on every delta.
	if (typeof Element.prototype.scrollTo !== 'function') {
		Element.prototype.scrollTo = () => {};
	}
});

afterEach(() => {
	resetChat();
});

describe('ChatColumn — mid-stream attribution', () => {
	it('gives each closed claim its own pill and leaves the tail plain', () => {
		const container = midStream(
			`Claim one ${marker(1, 'e1', V1)}. Claim two ${marker(2, 'e2', V2)}. ` +
				'Tail [3]{"eventId":"e1","quote":"RSA keygen runs'
		);

		const pills = screen.getAllByLabelText(/^Citation \d+:/);
		expect(pills.map((p) => p.textContent?.trim())).toEqual(['1', '2']);
		expect(pills[0].getAttribute('aria-label')).toBe(`Citation 1: ${E1.content}`);
		expect(pills[1].getAttribute('aria-label')).toBe(`Citation 2: ${E2.content}`);
		// Mid-stream the register does not exist yet, so the mark is a note,
		// not a dead button (it becomes one when the turn settles).
		expect(container.querySelectorAll('.assistant button')).toHaveLength(0);

		// Each pill sits inside its own claim's sentence; only the
		// unterminated tail is left as prose.
		expect(container.querySelector('.md-p')?.textContent).toBe(
			'Claim one1. Claim two2. Tail '
		);
		expect(answer(container)).not.toContain('eventId');
	});

	it('never styles the message when the only marker is partial', () => {
		const container = midStream('Only claim [1]{"eventId":"e1","quote":"RSA keygen runs in the cer');

		expect(answer(container)).toBe('Only claim ');
		expect(screen.queryAllByLabelText(/^Citation \d+:/)).toHaveLength(0);
		// No claim span and no mark: a partial marker styles nothing.
		expect(container.querySelector('.claim')).toBeNull();
		expect(container.querySelector('.cite-mark')).toBeNull();
		expect(answer(container)).not.toContain('eventId');
	});

	it('shows no verified pill for a claim whose quote is not in the event', () => {
		const container = midStream(`Bogus ${marker(1, 'e1', 'attacks exploit padding oracles')}.`);

		expect(answer(container)).toBe('Bogus.');
		expect(screen.queryAllByLabelText(/^Citation \d+:/)).toHaveLength(0);
		expect(container.querySelector('.claim')).toBeNull();
	});
});
