/**
 * Results-surface scroll memory (issue #142).
 *
 * The results list unmounts on the session hop, so the surface cannot keep
 * its own position in the DOM. A raw scrollTop restore drifts: cards above
 * the fold keep re-measuring while fills land (`content-visibility: auto`),
 * so the same pixel offset lands on different content. The first visible
 * card is the stable anchor — capture it with the offset it had relative to
 * the scroller's viewport, then re-align that card after the remount.
 *
 * Pure DOM math, no stores: the page owns when to capture and the frame
 * schedule for restoring.
 */

export interface ResultsAnchor {
	id: string;
	/** Card top minus the scroller's viewport top, in px. */
	offset: number;
}

export interface ResultsScrollMemory {
	/** The session the position belongs to — another session's offset is
	 * not this surface's position. */
	sessionId: string | null;
	top: number;
	anchor: ResultsAnchor | null;
}

/** Initial state: no results surface has captured a position yet. */
export const EMPTY_RESULTS_SCROLL: ResultsScrollMemory = {
	sessionId: null,
	top: 0,
	anchor: null
};

export function captureResultsScroll(
	el: HTMLElement,
	sessionId: string | null
): ResultsScrollMemory {
	return { sessionId, top: el.scrollTop, anchor: captureAnchor(el) };
}

/** First card whose bottom edge is below the scroller's top — binary search,
 * because wrappers render in visual order and a scan of 100+ rects on every
 * scroll event is needless. */
function captureAnchor(el: HTMLElement): ResultsAnchor | null {
	const cards = el.querySelectorAll<HTMLElement>('[data-card-id]');
	if (cards.length === 0) return null;
	const top = el.getBoundingClientRect().top;
	let lo = 0;
	let hi = cards.length - 1;
	let found: HTMLElement | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const rect = cards[mid].getBoundingClientRect();
		if (rect.bottom > top) {
			found = cards[mid];
			hi = mid - 1;
		} else {
			lo = mid + 1;
		}
	}
	if (found === null) return null;
	return {
		id: found.getAttribute('data-card-id') ?? '',
		offset: found.getBoundingClientRect().top - top
	};
}

/** Writes the numeric offset, then corrects it so the anchored card sits at
 * its remembered viewport offset. Returns false when the memory belongs to
 * another session (nothing is written). */
export function restoreResultsScroll(
	el: HTMLElement,
	memory: ResultsScrollMemory,
	sessionId: string | null
): boolean {
	if (memory.sessionId !== sessionId) return false;
	el.scrollTop = memory.top;
	if (memory.anchor === null) return true;
	const cards = el.querySelectorAll<HTMLElement>('[data-card-id]');
	const card =
		[...cards].find((c) => c.getAttribute('data-card-id') === memory.anchor?.id) ?? null;
	// The anchor card may be gone (filters changed, run replaced): the
	// numeric offset is the honest fallback, not a jump to nowhere.
	if (card === null) return true;
	const delta =
		card.getBoundingClientRect().top - el.getBoundingClientRect().top - memory.anchor.offset;
	if (delta !== 0) el.scrollTop += delta;
	return true;
}
