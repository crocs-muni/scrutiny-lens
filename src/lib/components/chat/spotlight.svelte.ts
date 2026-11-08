// Spotlight (issue #30, ruling 3) — the hover half of the coordination
// store. Every surface of one citation (the claim block that carries the
// mark, the mark itself, its register row) lights together while any of
// them is hovered. A claim block can carry SEVERAL citation numbers, so the
// active set is a list, not a single number.
//
// #184 removed the click-through half (mark → hover card → dossier): the
// card could not be reached by pointer travel, so it was deleted. Clicking
// a mark now opens its row in the always-visible register, which is plain
// component state — this store stays hover-only because hover must never
// change store-level state like the Selection.

let active = $state<number[]>([]);

/* Hover-bridge grace: clearing the spotlight the instant a mouseleave fires
 * makes the short gap between a mark and its register row (or between two
 * rows) flicker. Leaving is grace-deferred and any new hover cancels the
 * pending clear. One canonical timer for every surface. */
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
