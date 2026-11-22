/**
 * Trusted-publisher admission foundation (issue #214).
 *
 * The curated list is the default admission view (spec §2/§3, ADR 0004), so
 * the file it ships as must fail loudly when malformed, the key field must
 * accept every identifier a curator might paste without throwing, and local
 * add/remove must stay plain set arithmetic. Admission itself — direct trust,
 * binding reach, root chains — is fabric's oracle and is tested there.
 */
import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { nprofileEncode, nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { trustSymbol, type TrustProvider } from '$lib/fabric';
import {
	BUNDLED_TRUSTED,
	createTrustProvider,
	effectiveTrusted,
	parseTrustedList
} from '$lib/trust';
import { describePubkeyIssue, parsePubkeyInput } from '$lib/publisher';
import shippedRaw from '../src/lib/data/trusted-publishers.json';

describe('shipped trusted-publisher list', () => {
	it('parses through the same gate as any list file and is non-empty', () => {
		const parsed = parseTrustedList(shippedRaw);

		expect(parsed.publishers.length).toBeGreaterThan(0);
		expect(parsed.publishers).toEqual(BUNDLED_TRUSTED.publishers);
		expect(parsed.version).toBe(shippedRaw.version);
		expect(parsed.updated).toBe(shippedRaw.updated);
	});

	it('holds only 64-character lowercase hex pubkeys', () => {
		for (const publisher of BUNDLED_TRUSTED.publishers) {
			expect(publisher.pubkey).toMatch(/^[0-9a-f]{64}$/);
			expect(publisher.label.length).toBeGreaterThan(0);
		}
	});

	it('throws instead of silently accepting a malformed file', () => {
		expect(() => parseTrustedList({ version: 0, updated: '2026-11-22', publishers: [] })).toThrow(
			/Invalid trusted publisher list/
		);
		expect(() =>
			parseTrustedList({
				version: 1,
				updated: '2026-11-22',
				publishers: [{ pubkey: 'A'.repeat(64), label: 'Uppercase' }]
			})
		).toThrow(/64 lowercase hex/);
	});
});

describe('parsePubkeyInput', () => {
	const pubkey = BUNDLED_TRUSTED.publishers[0].pubkey;

	it('accepts hex, npub, and nprofile and canonicalises to lowercase hex', () => {
		expect(parsePubkeyInput(pubkey)).toEqual({ ok: true, pubkey });
		expect(parsePubkeyInput(pubkey.toUpperCase())).toEqual({ ok: true, pubkey });
		expect(parsePubkeyInput(`  ${npubEncode(pubkey)}  `)).toEqual({ ok: true, pubkey });
		expect(parsePubkeyInput(nprofileEncode({ pubkey }))).toEqual({ ok: true, pubkey });
	});

	it('rejects empty input with the empty reason', () => {
		expect(parsePubkeyInput('')).toEqual({
			ok: false,
			issue: { input: '', reason: 'empty' }
		});
		expect(parsePubkeyInput('   ')).toEqual({
			ok: false,
			issue: { input: '', reason: 'empty' }
		});
	});

	it('rejects short hex, garbage, a private key, and a broken npub by reason', () => {
		expect(parsePubkeyInput('deadbeef')).toEqual({
			ok: false,
			issue: { input: 'deadbeef', reason: 'bad-hex' }
		});
		expect(parsePubkeyInput('not a key')).toEqual({
			ok: false,
			issue: { input: 'not a key', reason: 'not-bech32' }
		});
		const nsec = nsecEncode(generateSecretKey());
		expect(parsePubkeyInput(nsec)).toEqual({
			ok: false,
			issue: { input: nsec, reason: 'wrong-kind' }
		});
		expect(parsePubkeyInput('npub1nothr')).toEqual({
			ok: false,
			issue: { input: 'npub1nothr', reason: 'invalid-payload' }
		});
	});

	it('turns every issue into non-empty human copy', () => {
		for (const reason of [
			'empty',
			'not-bech32',
			'wrong-kind',
			'invalid-payload',
			'bad-hex'
		] as const) {
			expect(describePubkeyIssue({ input: 'x', reason }).length).toBeGreaterThan(0);
		}
	});
});

describe('effectiveTrusted', () => {
	const [first, second, third] = BUNDLED_TRUSTED.publishers;
	const base = [
		{ pubkey: first.pubkey, label: 'Reviewed first' },
		{ pubkey: second.pubkey, label: 'Reviewed second' }
	];

	it('takes base then added order, dedupes, and lets removal win', () => {
		const effective = effectiveTrusted(base, [third.pubkey, first.pubkey.toUpperCase()], [
			second.pubkey
		]);

		expect(effective.map((publisher) => publisher.pubkey)).toEqual([first.pubkey, third.pubkey]);
		expect(effective[0].label).toBe('Reviewed first');
		expect(effective[1].label).toMatch(/^npub1/);
	});

	it('keeps the reviewed label when a base key is also in the added list', () => {
		const effective = effectiveTrusted(base, [first.pubkey], []);

		expect(effective).toHaveLength(2);
		expect(effective[0]).toEqual({ pubkey: first.pubkey, label: 'Reviewed first' });
	});

	it('labels a non-key entry with the empty string rather than inventing one', () => {
		expect(effectiveTrusted([], ['not-a-key'], [])).toEqual([
			{ pubkey: 'not-a-key', label: '' }
		]);
	});
});

describe('createTrustProvider', () => {
	it('is branded for fabric and rebuilds from scratch via deltaSince null', () => {
		const pubkey = BUNDLED_TRUSTED.publishers[0].pubkey;
		const provider: TrustProvider = createTrustProvider((key) => key === pubkey, 7);

		expect(provider[trustSymbol]).toBe(true);
		expect(provider.version).toBe(7);
		expect(provider.isTrusted(pubkey)).toBe(true);
		expect(provider.isTrusted('f'.repeat(64))).toBe(false);
		expect(provider.deltaSince(6)).toBeNull();
	});
});
