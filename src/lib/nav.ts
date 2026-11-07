/**
 * In-app navigation trail (issue #142) — the step stack the center
 * surface's breadcrumb bar renders.
 *
 * The app is a static SPA with no router (spec §8): "back" is a descend of
 * the in-app stack, never browser history, and the URL never changes. One
 * derivation owns what the bar shows and where the chevron/Esc ascend, so
 * the results and session surfaces cannot disagree about depth:
 * Results → session → subject.
 *
 * Labels are existing text only (spec §2 rule 1): the session question from
 * the shell and the subject's dossier title (cache-first or the rule-5
 * fallback already shown on the card). The bar generates nothing.
 */
import type { CenterView } from '$lib/shell.svelte';

/** What one back press does. `clear-subject` stays inside the session
 * surface (the graph anchor and drawer chrome survive); `results` returns
 * to the results surface at its preserved scroll position. */
export type AscendTarget = 'clear-subject' | 'results';

export interface NavCrumb {
	level: 'results' | 'session' | 'subject';
	/** Visible text — never generated for the bar. */
	label: string;
	/** A real destination: renders as a button. The current crumb is a span. */
	interactive: boolean;
	/** Always the deepest crumb: carries aria-current and receives focus
	 * after an ascend. */
	current: boolean;
}

export interface NavTrail {
	crumbs: NavCrumb[];
	/** The back chevron's exactly-one-level target; null = trail root. */
	up: AscendTarget | null;
}

/**
 * `subjectTitle` is the selected subject's existing dossier title, or null
 * when nothing is selected / the live run belongs to someone else.
 */
export function deriveNavTrail(input: {
	view: CenterView;
	sessionTitle: string | null;
	subjectTitle: string | null;
}): NavTrail | null {
	// Search is outside the stack (no session, no results): no bar.
	if (input.view !== 'results' && input.view !== 'session') return null;

	const onResults = input.view === 'results';
	const sessionTitle = input.sessionTitle?.trim() ?? '';
	// The subject crumb belongs to the session surface only (owner ruling,
	// #142): results keeps its Results → session anatomy even while a
	// selection lives on for the card ring.
	const subjectTitle = onResults ? '' : (input.subjectTitle?.trim() ?? '');
	const hasSubject = subjectTitle !== '';

	const crumbs: NavCrumb[] = [
		{
			level: 'results',
			label: 'Results',
			// On the results surface this is where you are; from a session it
			// is the way back.
			interactive: !onResults,
			current: false
		}
	];
	if (sessionTitle !== '') {
		crumbs.push({
			level: 'session',
			label: sessionTitle,
			// A crumb click clears the selected subject and keeps the graph
			// and drawer; with nothing selected it is the current level.
			interactive: hasSubject,
			current: false
		});
	}
	if (hasSubject) {
		crumbs.push({ level: 'subject', label: subjectTitle, interactive: false, current: true });
	}
	crumbs[crumbs.length - 1].current = true;

	return {
		crumbs,
		up: onResults ? null : hasSubject ? 'clear-subject' : 'results'
	};
}
