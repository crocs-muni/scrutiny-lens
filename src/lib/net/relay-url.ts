/**
 * Canonical relay URLs (issue #131, spec §8).
 *
 * WHY: relay URL strings arrive raw from every boundary — settings relays,
 * the env default pool, transport connection maps, seen-on hints — so the
 * slashed form (`wss://relay.primal.net/`) and the bare form
 * (`wss://relay.primal.net`) compare as two different relays while naming
 * one endpoint. This module is the single canonicalizer later steps route
 * those boundaries through: one relay, one string.
 *
 * Canonical form: `ws|wss:` + lowercase host (with port only when
 * non-default for the scheme) + path with trailing slash(es) stripped, the
 * root path omitted entirely. Non-ws/wss schemes are rejected (an https
 * origin is not a relay), but plain `ws://` stays legal — dev runs against
 * `ws://127.0.0.1:3334` via PUBLIC_RELAY_URLS. Pure functions on `new URL()`
 * so they are testable in node.
 */

export type RelayUrlIssueReason =
	| 'empty'
	| 'not-a-url'
	| 'bad-scheme'
	| 'credentials'
	| 'query-or-fragment'
	| 'empty-host';

/** A rejected input; carries the original string so callers can point at
 * the exact settings row / env entry that failed. */
export interface RelayUrlIssue {
	input: string;
	reason: RelayUrlIssueReason;
}

export type RelayUrlResult = { ok: true; url: string } | { ok: false; issue: RelayUrlIssue };

/** Human copy for a rejection, carrying the TRUE reason (spec §2 never-lie:
 * a query string or an embedded credential is not "not a ws:// url" — the
 * user must be told what actually failed). */
export function describeRelayIssue(issue: RelayUrlIssue): string {
	switch (issue.reason) {
		case 'empty':
			return `"${issue.input}" is empty.`;
		case 'not-a-url':
			return `"${issue.input}" is not a URL.`;
		case 'bad-scheme':
			return `"${issue.input}" is not a ws:// or wss:// relay URL.`;
		case 'credentials':
			return `"${issue.input}" embeds credentials — relay URLs must not.`;
		case 'query-or-fragment':
			return `"${issue.input}" carries a query or fragment — relay URLs must not.`;
		case 'empty-host':
			return `"${issue.input}" has no host.`;
	}
}

/** Canonicalizes one relay URL; never throws — failures come back as issues. */
export function canonicalRelayUrl(input: string): RelayUrlResult {
	const trimmed = input.trim();
	if (trimmed === '') return { ok: false, issue: { input, reason: 'empty' } };
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, issue: { input, reason: 'not-a-url' } };
	}
	// Scheme first: an https origin parses fine but is not a relay.
	if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
		return { ok: false, issue: { input, reason: 'bad-scheme' } };
	}
	if (parsed.username !== '' || parsed.password !== '') {
		return { ok: false, issue: { input, reason: 'credentials' } };
	}
	if (parsed.search !== '' || parsed.hash !== '') {
		return { ok: false, issue: { input, reason: 'query-or-fragment' } };
	}
	// Unreachable for ws/wss via the URL parser today (special schemes fail
	// on empty hosts), kept so a parser change surfaces here, not downstream.
	if (parsed.hostname === '') {
		return { ok: false, issue: { input, reason: 'empty-host' } };
	}
	// URL() already lowercased scheme+host and dropped the scheme-default
	// port (:80 ws / :443 wss) from .host — only the trailing slash(es)
	// remain to normalize away so `/` and `` stop being two relays.
	const path = parsed.pathname.replace(/\/+$/, '');
	return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}` };
}

/** Canonicalizes a list: rejected entries become issues, survivors are
 * deduped on the canonical value (first wins, order preserved). Never
 * throws. */
export function canonicalRelayUrls(inputs: readonly string[]): {
	urls: string[];
	issues: RelayUrlIssue[];
} {
	const urls: string[] = [];
	const seen = new Set<string>();
	const issues: RelayUrlIssue[] = [];
	for (const input of inputs) {
		const result = canonicalRelayUrl(input);
		if (result.ok) {
			if (!seen.has(result.url)) {
				seen.add(result.url);
				urls.push(result.url);
			}
		} else {
			issues.push(result.issue);
		}
	}
	return { urls, issues };
}
