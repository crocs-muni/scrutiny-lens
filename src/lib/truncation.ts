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
): { update: (next?: (truncated: boolean) => void) => void; destroy: () => void } {
	let callback = onChange;
	let clipped = false;
	// A destroyed action must never call back: fonts settle late, and a
	// swapped-out crumb would otherwise write `clipped` on a dead component.
	let destroyed = false;
	const update = (next?: (truncated: boolean) => void): void => {
		if (next !== undefined) callback = next;
		if (destroyed) return;
		const now = isTruncated(node);
		if (now === clipped) return;
		clipped = now;
		callback(now);
	};
	const observer =
		typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
	observer?.observe(node);
	const onResize = (): void => update();
	// With an observer the node's own box change already fires; the window
	// listener is the fallback, not a second source of the same event.
	if (observer === null) window.addEventListener('resize', onResize);
	// Fonts can settle after the first layout pass; re-measure once they do.
	void document.fonts?.ready.then(() => update(), () => {});
	update();
	return {
		update,
		destroy() {
			destroyed = true;
			observer?.disconnect();
			window.removeEventListener('resize', onResize);
		}
	};
}
