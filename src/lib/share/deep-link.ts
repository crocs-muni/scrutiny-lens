/**
 * Share-link encode/decode for issue #31 (spec §1 L22, §8).
 *
 * A share is a NIP-19 nevent carrying up to 3 seen-on relay hints plus the
 * author and kind (spec §8) — enough for a cold-open to query the right
 * relays and for the recipient to be told which hinted relays failed
 * (spec §4). Two channels are built from the same nevent (§1, spec §8):
 *   url      — the app's own event/ route (in-app cold open, ShareLinkScout
 *              verified nevent-in-path is the only share-safe part of the
 *              URL; query params are dropped by our SPA handling)
 *   nostrUri — the `nostr:` URI other nostr clients understand
 *
 * Protocol work (bech32/TLV for nevent) is delegated to nostr-tools/nip19 —
 * never hand-rolled (§2: the packet means what the decoder says, and we
 * reuse the reference encoder).
 */
import { decode, neventEncode, type DecodedResult } from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/core';

/** Decoded nevent: id is mandatory; hints/author/kind may be absent. */
export interface SharePointer {
	id: string;
	relays: string[];
	author?: string;
	kind?: number;
}

/** Thrown by decodeShareLink when the input is not a usable nevent share
 * link — message names what was actually received. Callers surface this to
 * the user verbatim (spec §2: never lie about what was pasted). */
export class ShareLinkDecodeError extends Error {}

const NOSTR_URI_PREFIX = 'nostr:';

/**
 * Parses a paste into a SharePointer. Accepts the bare `nevent1…` token,
 * an optional `nostr:` URI prefix (case-insensitive — users copy from any
 * client), and surrounding whitespace. Any other kind of code (note1, npub,
 * naddr, …) or non-code (hex event id, arbitrary text) is rejected with a
 * ShareLinkDecodeError naming what it got, so the cold-open never guesses.
 */
export function decodeShareLink(neventText: string): SharePointer {
	const trimmed = neventText.trim();
	const code = trimmed.toLowerCase().startsWith(NOSTR_URI_PREFIX)
		? trimmed.slice(NOSTR_URI_PREFIX.length).trim()
		: trimmed;

	// raw hex event ids are caught here rather than left to bech32's
	// checksum error so the message says what the user actually pasted.
	if (/^[0-9a-f]{64}$/i.test(code)) {
		throw new ShareLinkDecodeError('a raw event id (hex), not a nevent share link');
	}

	let decoded: DecodedResult;
	try {
		decoded = decode(code);
	} catch {
		throw new ShareLinkDecodeError(`not a valid nostr code: "${code.slice(0, 24)}…"`);
	}
	if (decoded.type !== 'nevent') {
		throw new ShareLinkDecodeError(`a ${decoded.type}, not a nevent share link`);
	}
	const { id, relays, author, kind } = decoded.data;
	return { id, relays: relays ?? [], author, kind };
}

/**
 * Builds both share channels for one event. `seenOn` is the event's
 * recorded seen-on relay list (seenOnRelays); at most 3 become hints
 * (spec §8) and they are passed through in first-observed order.
 * `base` is import.meta.env.BASE_URL, which always ends in '/' — so the
 * URL works identically for root-mounted and path-mounted deploys.
 */
export function buildShareLinks(subject: NostrEvent, seenOn: string[]): { url: string; nostrUri: string } {
	const nevent = neventEncode({
		id: subject.id,
		relays: seenOn.slice(0, 3),
		author: subject.pubkey,
		kind: subject.kind
	});
	const url = `${location.origin}${import.meta.env.BASE_URL}event/${nevent}`;
	return { url, nostrUri: `nostr:${nevent}` };
}
