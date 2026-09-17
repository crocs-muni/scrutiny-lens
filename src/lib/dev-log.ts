/* DEV-LOG — [lens-trace] diagnostic flag. Arm in the browser console:
 * `localStorage.setItem('lens-debug','1')` — the flag NEVER throws to the
 * caller (jsdom's opaque-origin SecurityError on getItem must not disable
 * the trajectory it decorates — a thrown probe inside admitContext's
 * try-catching tail silently aborted the whole settle pass in tests,
 * measured 2026-09-17). Remove alongside the diagnostic call sites. */
export function lensDebug(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem('lens-debug') === '1';
	} catch {
		return false;
	}
}
