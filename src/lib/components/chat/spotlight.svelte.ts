// Spotlight (issue #30, ruling 3) — the hover half of the coordination
// store. Every surface of one citation (claim runs across the answer, its
// pill, its source chip) lights together while any of them is hovered. A
// shared claim span carries SEVERAL citation numbers, so the active set is
// a list, not a single number. Click-through (pill → hover-card → open
// dossier) is the click half and lives in the components; this stays
// hover-only because hover must never change store-level state like the
// Selection.

let active = $state<number[]>([]);

/* Hover-bridge grace (chat-output rework T3, 2026-09-17): clearing the
 * spotlight the INSTANT a mouseleave fires makes the gap between pill and
 * hover-card impossible to cross — the card closed before the cursor could
 * reach it (live complaint). Leaving is now grace-deferred; any new hover
 * (trigger, sibling surface, the card itself) cancels the pending clear.
 * One canonical timer: pill, claim span, source chip and graph ring all
 * cross gaps the same way. */
const CLEAR_GRACE_MS = 180;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export const spotlight = {
	/** The citations currently under the cursor. */
	get active(): number[] {
		return active;
	},
	has(n: number): boolean {
		return active.includes(n);
	},
	/** Renderer-side membership: a run/pill/chip glows iff any hovered
	 * citation is among its marks. */
	lit(marks: number[]): boolean {
		return active.length > 0 && marks.some((n) => active.includes(n));
	},
	hover(ns: number[] | null): void {
		clearTimeout(clearTimer);
		clearTimer = undefined;
		if (ns !== null) {
			active = ns;
		} else if (active.length > 0) {
			clearTimer = setTimeout(() => {
				active = [];
			}, CLEAR_GRACE_MS);
		}
	}
};

/** Test seam — the singleton survives across spec files. */
export function resetSpotlight(): void {
	clearTimeout(clearTimer);
	clearTimer = undefined;
	active = [];
}
