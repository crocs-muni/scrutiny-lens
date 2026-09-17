/**
 * Chat answer marker scanner (chat-output rework T1, 2026-09-17).
 *
 * SINGLE OWNER of marker detection for the chat answer surface. Every
 * consumer — the agent's settle gate (resolveFinal), the live stream parser
 * (streamParse), the live renderer (ChatLiveMessage pre-parser) — scans
 * through THIS. The previous regex grammar (`\{([^{}]*)\}`) had a hard leak:
 * a model payload containing NESTED braces (observed live:
 * `[2]{"eventId":"…","quote":"Kyber":{"KYBER":1,…}}`) failed the capture,
 * bypassed every gate, and rendered the raw corrupt JSON as prose
 * (screenshot-confirmed "vibecoded" chat, PQC card chat).
 *
 * The scanner is a small deterministic state machine: `[N]` followed
 * (optionally after whitespace) by a JSON object read by brace/quote/escape
 * tracking. It never throws; malformed spans are REPORTED (json === null),
 * and the consumer's strip-policies decide their fate — malformed or
 * unverifiable markers are stripped from content outright (user ruling
 * 2026-09-17), never rendered.
 */

export interface MarkerScan {
	/** Offset of the `[` of `[N]`. */
	start: number;
	/** Offset one past the closing `}` (or past `[N]` when no braces follow). */
	end: number;
	/** The model's marker number. */
	n: number;
	/** True when the scan reached a definite end (bare [N], or a closing brace). False for an unterminated brace-run — the stream-tail withhold case. */
	terminated: boolean;
	/** Extracted object text INCLUDING the braces, when the brace-run is
	 * balanced AND parses as JSON; null for a malformed/unterminated run
	 * (strip at settle, withhold-tail candidate mid-stream). */
	objectText: string | null;
	/** True when a `{` followed the `[N]` — the settle gate strips
	 * malformed BRACED markers but never bare canonical `[N]` tokens
	 * (those carry the surviving pills' numbers). */
	braced: boolean;
}

/** Scan `text` for `[N]{…}` occurrences; balanced-brace reads honor JSON
 * string quoting/escapes so quotes inside a payload never end the object.
 * A `}`-less or brace-unbalanced tail yields objectText === null. */
export function scanMarkers(text: string): MarkerScan[] {
	const out: MarkerScan[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] !== '[') {
			i += 1;
			continue;
		}
		let j = i + 1;
		while (j < text.length && text[j] >= '0' && text[j] <= '9') j += 1;
		if (j === i + 1 || j >= text.length || text[j] !== ']') {
			i += 1;
			continue;
		}
		const n = Number.parseInt(text.slice(i + 1, j), 10);
		// Optional whitespace, then an object start.
		let k = j + 1;
		while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k += 1;
		if (k >= text.length || text[k] !== '{') {
			// Bare [N]: canonical renumber token — NOT a brace marker. Still
			// report it (end at the `]`): settle-time consumers strip bare
			// numbers whose citation did not survive; render-time consumers
			// need them for the pill layout.
			out.push({ start: i, end: j + 1, n, objectText: null, braced: false, terminated: true });
			i = j + 1;
			continue;
		}
		// Balanced read: track depth, strings, escapes.
		let depth = 0;
		let inString = false;
		let escaped = false;
		let close = -1;
		for (let p = k; p < text.length; p += 1) {
			const c = text[p];
			if (inString) {
				if (escaped) escaped = false;
				else if (c === '\\') escaped = true;
				else if (c === '"') inString = false;
				continue;
			}
			if (c === '"') inString = true;
			else if (c === '{') depth += 1;
			else if (c === '}') {
				depth -= 1;
				if (depth === 0) {
					close = p;
					break;
				}
			}
		}
		if (close === -1) {
			// Unterminated object: the span runs to whatever remains; the
			// settle gate strips it, the stream parser withholds it.
			out.push({ start: i, end: text.length, n, objectText: null, braced: true, terminated: false });
			return out;
		}
		const objectText = text.slice(k, close + 1);
		let parses = false;
		try {
			JSON.parse(objectText);
			parses = true;
		} catch {
			parses = false;
		}
		out.push({ start: i, end: close + 1, n, objectText: parses ? objectText : null, braced: true, terminated: true });
		i = close + 1;
	}
	return out;
}
