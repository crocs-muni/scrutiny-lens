// Results scroll memory (issue #142): the visible-card anchor and its
// session key. jsdom has no layout, so the surface here stubs rects that
// follow `scrollTop` exactly like a settled list would.

import { describe, expect, it } from 'vitest';
import {
	captureResultsScroll,
	restoreResultsScroll,
	type ResultsScrollMemory
} from '$lib/scroll-memory';

const rect = (top: number, height: number): DOMRect =>
	({
		top,
		bottom: top + height,
		left: 0,
		right: 0,
		width: 0,
		height,
		x: 0,
		y: top,
		toJSON: () => ({})
	}) as DOMRect;

/** A scroll surface whose card rects derive from its (fake) scrollTop. */
function surface(offsets: number[], { containerTop = 100, cardHeight = 151 } = {}) {
	const el = document.createElement('div');
	let scrollTop = 0;
	Object.defineProperty(el, 'scrollTop', {
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
		configurable: true
	});
	el.getBoundingClientRect = () => rect(containerTop, 600);
	offsets.forEach((offset, i) => {
		const card = document.createElement('div');
		card.setAttribute('data-card-id', `card-${i}`);
		card.getBoundingClientRect = () => rect(containerTop + offset - scrollTop, cardHeight);
		el.appendChild(card);
	});
	return {
		el,
		offsetOf(id: string): number | null {
			const card = el.querySelector(`[data-card-id="${id}"]`);
			return card
				? Math.round(card.getBoundingClientRect().top - el.getBoundingClientRect().top)
				: null;
		}
	};
}

describe('captureResultsScroll', () => {
	it('anchors on the first card still crossing the scroller top', () => {
		const { el } = surface([0, 151, 302]);
		el.scrollTop = 150;
		expect(captureResultsScroll(el, 'session-a')).toEqual({
			sessionId: 'session-a',
			top: 150,
			// Card 0 starts 150px above the scroller's viewport top (100).
			anchor: { id: 'card-0', offset: -150 }
		});

		// 151px down, card 0's bottom is exactly the scroller top: the next
		// card is the first visible one.
		el.scrollTop = 151;
		expect(captureResultsScroll(el, 'session-a').anchor).toEqual({
			id: 'card-1',
			offset: 0
		});
	});

	it('records the numeric offset with no anchor when nothing is listed', () => {
		const { el } = surface([]);
		el.scrollTop = 240;
		expect(captureResultsScroll(el, 'session-b')).toEqual({
			sessionId: 'session-b',
			top: 240,
			anchor: null
		});
	});
});

describe('restoreResultsScroll', () => {
	const memory = (over: Partial<ResultsScrollMemory> = {}): ResultsScrollMemory => ({
		sessionId: 'session-a',
		top: 300,
		anchor: null,
		...over
	});

	it('re-aligns the anchored card to its remembered viewport offset', () => {
		const { el, offsetOf } = surface([0, 200, 400]);
		el.scrollTop = 300;
		expect(offsetOf('card-1')).toBe(-100);

		const ok = restoreResultsScroll(
			el,
			memory({ anchor: { id: 'card-1', offset: 12 } }),
			'session-a'
		);
		expect(ok).toBe(true);
		// The card sits 112px too high: scrolling up that much puts it back
		// at +12px, on top of the numeric write.
		expect(el.scrollTop).toBe(188);
		expect(offsetOf('card-1')).toBe(12);
	});

	it('refuses another session position and writes nothing', () => {
		const { el } = surface([0, 200, 400]);
		el.scrollTop = 300;
		const ok = restoreResultsScroll(el, memory({ top: 900 }), 'session-b');
		expect(ok).toBe(false);
		expect(el.scrollTop).toBe(300);
	});

	it('keeps the numeric offset when the anchor card is gone', () => {
		const { el } = surface([0, 200]);
		const ok = restoreResultsScroll(
			el,
			memory({ top: 420, anchor: { id: 'card-9', offset: 5 } }),
			'session-a'
		);
		expect(ok).toBe(true);
		expect(el.scrollTop).toBe(420);
	});
});
