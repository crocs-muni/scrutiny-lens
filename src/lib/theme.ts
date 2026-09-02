// Theme application (issue #11, spec §5/§9): toggles the .dark token
// variant on <html> per the settings appearance. All tokens swap at once,
// so .theme-switching freezes transitions for exactly one frame — the flip
// is one clean repaint, not hundreds of mismatched fades (app.css carries
// the freeze rule).

import { MediaQuery } from 'svelte/reactivity';
import type { Appearance } from '$lib/config';

/** Reactive media query — read synchronously inside applyTheme so the
 * layout's theme $effect tracks both the setting and the OS preference. */
export const prefersDark = new MediaQuery('(prefers-color-scheme: dark)');

export function applyTheme(appearance: Appearance): void {
	if (typeof document === 'undefined') return;
	const dark = appearance === 'dark' || (appearance === 'system' && prefersDark.current);
	const root = document.documentElement;
	root.classList.add('theme-switching');
	root.classList.toggle('dark', dark);
	requestAnimationFrame(() => root.classList.remove('theme-switching'));
}
