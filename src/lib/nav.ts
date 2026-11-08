/**
 * In-app navigation trail (issue #142) — what the center surface's
 * breadcrumb bar renders and where the chevron/Esc ascend.
 *
 * The app is a static SPA with no router (spec §8): "back" is a pop of the
 * in-app stacks, never browser history, and the URL never changes. The model
 * has two real center pages — Results and the session graph — plus one piece
 * of session state on the bar:
 *
 *   Results [section] › question [Results] › anchor card [current]
 *
 * `Results` is a section label, not a crumb: the question crumb is the real
 * Results destination, and the anchor card is the session's current graph
 * subject (spec §9:103). A canvas click moves the drawer selection only; it
 * never moves the card. The card changes only when a product is selected
 * from OUTSIDE the canvas (results card, drawer deep-link, chat citation).
 *
 * The chevron pops one anchor: the previous card and the drawer event that
 * was selected when it was re-anchored. When there is no anchor history it
 * returns to Results. The previous-anchor title is reused verbatim; the bar
 * generates no text (spec §2 rule 1).
 */
import type { CenterView } from '$lib/shell.svelte';

/** What one back press does. `previous-anchor` restores the previous graph
 * anchor and its drawer selection; `results` returns to the results surface
 * at its preserved position. */
export type AscendTarget = 'previous-anchor' | 'results';

/** A real crumb destination. The question crumb opens Results; the current
 * card is a span, never a button. */
export type NavAction = 'results';

export interface NavCrumb {
	level: 'session' | 'subject';
	/** Visible text — never generated for the bar. */
	label: string;
	/** A real destination; null renders the current crumb as a span. */
	action: NavAction | null;
	/** Always the deepest crumb: carries aria-current. After an ascend the
	 * bar focuses the next back control (the chevron) or the bar itself. */
	current: boolean;
	/** Machine-made fallback text (rule-5 title): render in mono. */
	mono: boolean;
}

export interface NavTrail {
	/** The app section heading outside the breadcrumb list. */
	rootLabel: 'Results';
	crumbs: NavCrumb[];
	/** The back chevron's exactly-one-step target; null = trail root. */
	up: AscendTarget | null;
	/** The chevron's accessible label ("Back to results" or the previous
	 * card's on-screen title). */
	upLabel: string;
	/** Polite live text for the changed trail (screen readers hear the new
	 * level and the next back destination; the visible bar has no motion). */
	live: string;
}

/** Shell.newSession's default; a blank shell title must not paint `Results`
 * as the current level (issue #142 review). */
const UNTITLED_SESSION = 'Untitled session';

/**
 * `subjectTitle` is the GRAPH ANCHOR's existing node title (card title,
 * cached node tile, else the rule-5 fallback); null when there is no anchor
 * or the live run belongs to someone else. It is deliberately not the
 * drawer selection's dossier title: a canvas click can change the selection
 * without changing the card.
 */
export function deriveNavTrail(input: {
	view: CenterView;
	sessionTitle: string | null;
	subjectTitle: string | null;
	subjectMono: boolean;
	/** The previous anchor's on-screen title, or null when the history is
	 * empty (the back target is then Results). */
	previousAnchorTitle: string | null;
}): NavTrail | null {
	// Search is outside the stack (no session, no results): no bar.
	if (input.view !== 'results' && input.view !== 'session') return null;

	const onResults = input.view === 'results';
	const sessionTitle = input.sessionTitle?.trim() || UNTITLED_SESSION;
	// The anchor card belongs to the session surface only; results keeps its
	// Results › question anatomy while the ring/card state lives on.
	const subjectTitle = onResults ? '' : (input.subjectTitle?.trim() ?? '');
	const hasSubject = subjectTitle !== '';
	const previousAnchorTitle = onResults ? null : (input.previousAnchorTitle?.trim() || null);

	const crumbs: NavCrumb[] = [
		{
			level: 'session',
			label: sessionTitle,
			// The question is the results page. With an anchor open it is one
			// step up; at the trail root it is where the user already is.
			action: hasSubject ? 'results' : null,
			current: !hasSubject,
			mono: false
		}
	];
	if (hasSubject) {
		crumbs.push({
			level: 'subject',
			label: subjectTitle,
			action: null,
			current: true,
			mono: input.subjectMono
		});
	}

	const up: AscendTarget | null = onResults
		? null
		: hasSubject && previousAnchorTitle !== null
			? 'previous-anchor'
			: 'results';
	const upLabel =
		up === 'previous-anchor'
			? `Back to ${previousAnchorTitle}`
			: up === 'results'
				? 'Back to results'
				: '';
	const current = crumbs[crumbs.length - 1];
	const live =
		up === null ? `At ${current.label}` : `At ${current.label}; ${upLabel}`;

	return { rootLabel: 'Results', crumbs, up, upLabel, live };
}
