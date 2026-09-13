// Spotlight (issue #30, ruling 3) — the hover half of the coordination
// store. Every surface of one citation (claim runs across the answer, its
// pill, its source chip) lights together while any of them is hovered. A
// shared claim span carries SEVERAL citation numbers, so the active set is
// a list, not a single number. Click-through (pill → hover-card → open
// dossier) is the click half and lives in the components; this stays
// hover-only because hover must never change store-level state like the
// Selection.

let active = $state<number[]>([]);

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
		active = ns ?? [];
	}
};

/** Test seam — the singleton survives across spec files. */
export function resetSpotlight(): void {
	active = [];
}
