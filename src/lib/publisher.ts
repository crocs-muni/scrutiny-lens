// Publisher identity fallback (issue #38, spec §9 card anatomy; issue #135).
// When no kind-0 profile resolves, the chip still owes the reader an honest
// cell: the deterministic inline identicon plus the machine-made npub token.
// Both are DERIVED FROM THE PUBKEY ALONE — no random state, no third-party
// host (spec §1) — which is what lets a unit test assert "never blank, never
// flickering" without mounting the component (UI-free like $lib/trace).
//
// Why this lives outside the component: #135's second acceptance line is that
// an unresolvable author yields the deterministic fallback rather than
// nothing. A pure function can carry that assertion in the node test env,
// where the chip's DOM cannot mount.

import { decode, npubEncode } from 'nostr-tools/nip19';

/** Full npub for the tooltip; falls back to the raw key if bech32 encode
 * fails (a malformed author id must degrade, never throw inside a chip). */
export function publisherNpub(pubkey: string): string {
	try {
		return npubEncode(pubkey);
	} catch {
		return pubkey;
	}
}

/** The mono label token: the npub's first 8 chars + trailing 4. Always
 * derived, so a card can never render an empty identity cell — the worst
 * case for a malformed key is the raw key sliced the same way. Takes the
 * ALREADY-DERIVED npub so a card pays one bech32 encode, not two. */
export function publisherToken(npub: string): string {
	return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}

/** FNV-1a over the pubkey → a stable hue seed for the identicon's ink
 * (full uint32; the render maps it into oklch's hue wheel — the value must
 * NOT be pre-modded since mirroredCells consumes it too). */
export function publisherHue(pubkey: string): number {
	let hash = 0x811c9dc5;
	for (const ch of pubkey) {
		hash ^= ch.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Deterministic 5×5 two-tone pattern from the hue seed: the left-top 3×3
 * region is mirrored both ways so the icon reads symmetric at 16px. Bit i
 * of a per-cell keyed mix picks each cell's tone — no random state, so one
 * author wears the same icon on every surface, every load, cached or fresh.
 * Takes the seed the chip already derived, so one card pays one hash pass. */
export function identiconCells(seed: number): boolean[][] {
	const grid: boolean[][] = [];
	for (let y = 0; y < 5; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < 5; x++) {
			const sy = y <= 2 ? y : 4 - y;
			const sx = x <= 2 ? x : 4 - x;
			const i = sy * 3 + sx;
			const bit = Math.imul(seed, i + 1) + 0x9e3779b9 + sx * 37 + sy * 91;
			row.push(((bit >>> i) & 1) === 1);
		}
		grid.push(row);
	}
	return grid;
}

/* ── Trusted-publisher key entry (issue #214) ─────────────────────────────────
 * A local trust list accepts a publisher key pasted from anywhere: an npub, an
 * nprofile, or the raw 64-character hex. The parser never throws, so Settings
 * can render a field-level sentence instead of a stack trace. */

export type PubkeyInputIssueReason =
	| 'empty'
	| 'not-bech32'
	| 'wrong-kind'
	| 'invalid-payload'
	| 'bad-hex';

export interface PubkeyInputIssue {
	input: string;
	reason: PubkeyInputIssueReason;
}

export type PubkeyInputResult =
	| { ok: true; pubkey: string }
	| { ok: false; issue: PubkeyInputIssue };

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

export function parsePubkeyInput(input: string): PubkeyInputResult {
	const value = typeof input === 'string' ? input.trim() : '';
	if (!value) {
		return { ok: false, issue: { input: value, reason: 'empty' } };
	}

	if (HEX_64.test(value)) {
		return { ok: true, pubkey: value.toLowerCase() };
	}

	// Hex-looking but the wrong length is a truncated/extra-character key,
	// not a failed bech32 decode — even when the hex happens to contain '1'.
	if (HEX_ONLY.test(value)) {
		return { ok: false, issue: { input: value, reason: 'bad-hex' } };
	}

	const separator = value.lastIndexOf('1');
	if (separator <= 0) {
		return { ok: false, issue: { input: value, reason: 'not-bech32' } };
	}

	const lower = value.toLowerCase();
	const hrp = lower.slice(0, separator);
	if (!/^[a-z]+$/.test(hrp)) {
		return { ok: false, issue: { input: value, reason: 'not-bech32' } };
	}

	try {
		const decoded = decode(lower);
		if (decoded.type === 'npub') {
			return HEX_64.test(decoded.data)
				? { ok: true, pubkey: decoded.data.toLowerCase() }
				: { ok: false, issue: { input: value, reason: 'invalid-payload' } };
		}
		if (decoded.type === 'nprofile') {
			return HEX_64.test(decoded.data.pubkey)
				? { ok: true, pubkey: decoded.data.pubkey.toLowerCase() }
				: { ok: false, issue: { input: value, reason: 'invalid-payload' } };
		}
		return { ok: false, issue: { input: value, reason: 'wrong-kind' } };
	} catch {
		// An npub/nprofile that fails to decode is a malformed key, not some
		// unrelated token — tell the reader which one it is.
		return {
			ok: false,
			issue: {
				input: value,
				reason: hrp === 'npub' || hrp === 'nprofile' ? 'invalid-payload' : 'not-bech32'
			}
		};
	}
}

const PUBKEY_ISSUE_COPY: Record<PubkeyInputIssueReason, string> = {
	empty: 'Paste a publisher key — an npub, an nprofile, or a 64-character hex key.',
	'not-bech32': 'That is not a Nostr key. Use an npub, an nprofile, or a 64-character hex key.',
	'wrong-kind':
		'That is a different kind of Nostr identifier, not a publisher key. Use an npub, an nprofile, or a 64-character hex key.',
	'invalid-payload': 'That key is not a valid publisher key. Check the characters and paste it again.',
	'bad-hex': 'A hex publisher key is exactly 64 characters long.'
};

export function describePubkeyIssue(issue: PubkeyInputIssue): string {
	return PUBKEY_ISSUE_COPY[issue.reason];
}
