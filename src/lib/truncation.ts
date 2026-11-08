/** CSS truncation helpers for the breadcrumb crumb labels.
 *
 * Tooltips are a supplement for clipped labels, not a permanent affordance:
 * Fluent, Carbon and PatternFly show them only when the visible text is
 * shortened, and the APG breadcrumb pattern does not specify one at all.
 * The full label stays in the DOM and the accessible name either way.
 */

/** True when the element's rendered text is clipped by its box. The 1px
 * tolerance absorbs sub-pixel scrollWidth rounding in Chromium. */
export function isTruncated(node: HTMLElement): boolean {
	return node.scrollWidth > node.clientWidth + 1;
}

/** Svelte action: reports when the element starts or stops clipping. The
 * observer covers bar resizes and label changes; the window listener is the
 * jsdom/older-browser fallback when ResizeObserver is absent. */
export function truncation(
	node: HTMLElement,
	onChange: (truncated: boolean) => void
): { update: () => void; destroy: () => void } {
	let clipped = false;
	const update = (): void => {
		const next = isTruncated(node);
		if (next === clipped) return;
		clipped = next;
		onChange(next);
	};
	const observer =
		typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
	observer?.observe(node);
	const onResize = (): void => update();
	window.addEventListener('resize', onResize);
	// Fonts can settle after the first layout pass; re-measure once they do.
	void document.fonts?.ready.then(update, () => {});
	update();
	return {
		update,
		destroy() {
			observer?.disconnect();
			window.removeEventListener('resize', onResize);
		}
	};
}
