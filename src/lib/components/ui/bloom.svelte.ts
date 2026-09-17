/* First-paint bloom (issue #82): motion marks CHANGE after the first
 * stable paint, never provenance — cache-open calm is the ruling, so the
 * FIRST observed value is the baseline and can never bloom; only a
 * genuine false→true flip mid-life earns one settle mark.
 *
 * `by` keys the baseline for surfaces that swap subjects in place (the
 * drawer's dossier): a swap resets the observed state, or subject B's
 * first view would bloom off subject A's baseline — motion asserting
 * provenance instead of change. The contract lives in this one helper
 * because three surfaces carried verbatim copies of the null-triad and
 * drifted once already (the drawer missed the reset until code review).
 *
 * Access as `bloom.active` in reactive contexts — destructuring reads
 * the getter once and breaks reactivity. `clear()` ends the mark on
 * animationend so the class is removable. */
export function firstPaintBloom(read: () => boolean, by?: () => string | null) {
	let active = $state(false);
	let observed: boolean | null = null;
	let observedKey: string | null = null;
	$effect(() => {
		if (by !== undefined) {
			const key = by();
			if (key !== observedKey) {
				observedKey = key;
				observed = null;
				active = false;
			}
		}
		const now = read();
		if (observed === null) {
			observed = now;
			return;
		}
		if (now && !observed) active = true;
		observed = now;
	});
	return {
		get active() {
			return active;
		},
		clear() {
			active = false;
		},
	};
}
