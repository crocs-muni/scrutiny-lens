import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import {
	naddrEncode,
	neventEncode,
	noteEncode,
	npubEncode
} from 'nostr-tools/nip19';
import { buildShareLinks, decodeShareLink, ShareLinkDecodeError } from '$lib/share/deep-link';

// buildShareLinks reads location.origin + import.meta.env.BASE_URL at call
// time; node has neither, so the tests stub both under their control.
const STUB_ORIGIN = 'https://scrutiny.example';

let realLocation: PropertyDescriptor | undefined;
let realBase: string;

beforeEach(() => {
	realLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
	realBase = import.meta.env.BASE_URL;
	Object.defineProperty(globalThis, 'location', {
		value: { origin: STUB_ORIGIN },
		writable: true,
		configurable: true
	});
});

afterEach(() => {
	if (realLocation) Object.defineProperty(globalThis, 'location', realLocation);
	else delete (globalThis as { location?: unknown }).location;
	import.meta.env.BASE_URL = realBase;
});

function makeEvent(id = '11'.repeat(32), kind = 1): NostrEvent {
	return {
		id,
		pubkey: 'ab'.repeat(32),
		created_at: 1_700_000_000,
		kind,
		tags: [],
		content: 'event',
		sig: 'cd'.repeat(64)
	};
}

/** Pulls the `nevent1…` token out of either share channel (the app URL has
 * a path prefix; the nostr: URI has a scheme prefix). */
function extractNevent(link: string): string {
	const idx = link.indexOf('nevent1');
	return link.slice(idx).replace(/[^a-z0-9]+$/i, '');
}

describe('buildShareLinks (issue #31, spec §1 L22 + §8)', () => {
	it('encodes author + kind and up to 3 relay hints into both channels', () => {
		const subject = makeEvent();
		const { url, nostrUri } = buildShareLinks(subject, [
			'wss://a',
			'wss://b',
			'wss://c',
			'wss://d' // 4th must be dropped: hints cap is ≤3 (+1 spare)
		]);

		expect(nostrUri).toBe(`nostr:${extractNevent(url)}`);
		const pointer = decodeShareLink(extractNevent(url));
		expect(pointer).toEqual({
			id: subject.id,
			relays: ['wss://a', 'wss://b', 'wss://c'],
			author: subject.pubkey,
			kind: subject.kind
		});
	});

	it('builds the app URL under a root mount and a path mount', () => {
		const subject = makeEvent();

		import.meta.env.BASE_URL = '/';
		const root = buildShareLinks(subject, ['wss://a']);
		expect(root.url).toBe(`${STUB_ORIGIN}/event/${extractNevent(root.url)}`);

		import.meta.env.BASE_URL = '/scrutiny-lens/';
		const mounted = buildShareLinks(subject, ['wss://a']);
		expect(mounted.url).toBe(
			`${STUB_ORIGIN}/scrutiny-lens/event/${extractNevent(mounted.url)}`
		);
	});

	it('round-trips an empty seen-on list (hints empty, author/kind present)', () => {
		const subject = makeEvent();
		const { nostrUri } = buildShareLinks(subject, []);
		const pointer = decodeShareLink(nostrUri);
		expect(pointer.id).toBe(subject.id);
		expect(pointer.relays).toEqual([]);
		expect(pointer.author).toBe(subject.pubkey);
		expect(pointer.kind).toBe(subject.kind);
	});

	// F5a: the subject shape is only the three nevent fields — a caller
	// with just an event id/pubkey/kind (dossier row, enhanced href) must
	// be able to share without fabricating a full NostrEvent.
	it('accepts the three-field subject shape (id/pubkey/kind only)', () => {
		const links = buildShareLinks(
			{ id: '11'.repeat(32), pubkey: 'ab'.repeat(32), kind: 1 },
			[]
		);
		expect(decodeShareLink(extractNevent(links.url)).id).toBe('11'.repeat(32));
	});
});

describe('decodeShareLink (issue #31, spec §1 L22)', () => {
	it('accepts the nostr: URI prefix and surrounding whitespace', () => {
		const subject = makeEvent();
		const { nostrUri } = buildShareLinks(subject, ['wss://a']);
		const nav = extractNevent(nostrUri);
		expect(decodeShareLink(`  ${nostrUri} \n`).id).toBe(subject.id);
		expect(decodeShareLink(`NOSTR:${nav}`).id).toBe(subject.id);
	});

	it('rejects note1 with an error naming the actual code type', () => {
		const subject = makeEvent();
		const note = noteEncode(subject.id);
		expect(() => decodeShareLink(note)).toThrowError(ShareLinkDecodeError);
		expect(() => decodeShareLink(note)).toThrow(/note/);
	});

	it('rejects npub, naddr and raw hex with a ShareLinkDecodeError naming them', () => {
		const npub = npubEncode('ab'.repeat(32));
		expect(() => decodeShareLink(npub)).toThrowError(ShareLinkDecodeError);

		const hex = 'ff'.repeat(32);
		const errHex = () => decodeShareLink(hex);
		expect(errHex).toThrowError(ShareLinkDecodeError);
		expect(errHex).toThrow(/event id/);

		const naddr = naddrEncode({ identifier: 'x', pubkey: 'ab'.repeat(32), kind: 1 });
		const errAddr = () => decodeShareLink(naddr);
		expect(errAddr).toThrowError(ShareLinkDecodeError);
		expect(errAddr).toThrow(/naddr/);
	});

	it('rejects garbage text with a ShareLinkDecodeError', () => {
		expect(() => decodeShareLink('hello world')).toThrowError(ShareLinkDecodeError);
		expect(() => decodeShareLink('')).toThrowError(ShareLinkDecodeError);
	});

	it('revives a pointer with missing optional TLVs', () => {
		// A nevent encoded WITHOUT hints/author/kind still decodes; id is the
		// only mandatory field the pointer must carry.
		const bare = neventEncode({ id: '22'.repeat(32) });
		const pointer = decodeShareLink(bare);
		expect(pointer).toEqual({ id: '22'.repeat(32), relays: [] });
	});
});
