/**
 * Tooltip wording for the vocabulary the UI shows without explaining
 * (issue #39). One module so the result card, the graph node and the
 * dossier header never disagree (spec §9: one icon pair across surfaces).
 * Casing and length follow the tooltip rules: noun phrase, sentence case,
 * no trailing period, two lines at most. "Artifacts" is the CONTEXT.md
 * term; the visible count word stays "files" (spec §9 Files row).
 */

export const TERM_BOUND_RECORDS = 'Records bound to this record';
export const TERM_ARTIFACTS = 'Artifacts named by this record or its bound records';
/** The visible word is "updates"; the tooltip bridges to the protocol term. */
export const TERM_PATCHES = "Patches: edits to this record's content";

/** Spec §0: every record is a signed Nostr event; the type word leads. */
export function recordTypeTerm(type: 'product' | 'metadata'): string {
	const word = type === 'product' ? 'Product' : 'Metadata';
	return `${word} record: every SCRUTINY record is a signed Nostr event`;
}
