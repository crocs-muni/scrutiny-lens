/** Harness collapse contract (issue #10): width-only 280ms, copy exits in
 * 180ms ahead of the width. One copy — rail, chat, and drawer all consume
 * these so the harness rule can't silently diverge. The easing resolves to
 * the `--ease-link` token (spec §9 token infrastructure). */
export const COLLAPSE = {
	duration: 280,
	copyDuration: 180,
	copyOffset: 8,
	easing: 'var(--ease-link)'
} as const;
