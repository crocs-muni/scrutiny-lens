/**
 * The one display clip (…-ellipsis) — cards.ts, query.ts, and the dossier
 * verb surfaces all grew the same private copy. Deterministic presentation
 * only: the value (count, row identity, edges) never changes, and the full
 * text stays reachable (content panes or title attributes). ai/agents/
 * nodes.ts keeps its own variant deliberately (it .trims + .trimEnds —
 * input hygiene, a different job, not this one).
 */
export function clip(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Middle clip — corpus binding verbs are machine sentences whose
 * distinguishing payload ("reference A → B") sits at the TAIL
 * ("SCRUTINY Binding: <hash> ↔ <hash> reference …"), so the head clip
 * above renders every label identically (owner pass 2026-09-14: 18/18
 * identical chips on a live corpus). Keep both ends: head + … + tail,
 * preferring room for the tail. */
export function clipMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const tail = Math.min(16, Math.max(8, Math.floor(max / 2)));
	const head = max - tail - 1;
	return s.slice(0, head) + '…' + s.slice(s.length - tail);
}
