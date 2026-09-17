/**
 * Test-corpus seam contract (bootstrap 2026-09-16: jcalgtest re-tag +
 * sec-certs port, PUBLIC_INCLUDE_TEST_TAGS). The flag is frozen at module
 * load ($env/dynamic/public), so every assertion branches on the RUN's flag
 * state — run the suite once with the flag unset (default ON, how production
 * sensible) and once with PUBLIC_INCLUDE_TEST_TAGS=0 (quarantine) to cover
 * both. Byte-identical OFF behaviour is pinned by the whole existing suite.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { admitBatch, type NostrEvent } from '$lib/fabric';
import { indexerFilter, patchesReferencing } from '$lib/fabric';
import {
	extendWithTest,
	filterWithTestTags,
	rewriteIncomingTags
} from '$lib/fabric/test-tags';
import { includeTestTags, parseIncludeTestTags } from '$lib/config';

describe('parseIncludeTestTags', () => {
	it('defaults ON for unset/blank; accepts truthy forms only', () => {
		expect(parseIncludeTestTags(undefined)).toBe(true);
		expect(parseIncludeTestTags('')).toBe(true);
		expect(parseIncludeTestTags('  ')).toBe(true);
		expect(parseIncludeTestTags('1')).toBe(true);
		expect(parseIncludeTestTags('TRUE')).toBe(true);
		expect(parseIncludeTestTags('yes')).toBe(true);
		expect(parseIncludeTestTags('0')).toBe(false);
		expect(parseIncludeTestTags('false')).toBe(false);
		expect(parseIncludeTestTags('no')).toBe(false);
	});
});

/** Genuinely-signed FULL-MIRROR -test metadata event: the NIP-01 id recomputes
 * over the -test tags, exactly as a relay-stored test event would. */
function testMetadata(): NostrEvent {
	return finalizeEvent(
		{
			kind: 1,
			created_at: 1_789_500_000,
			tags: [
				['t', 'scrutiny-fabric-test'],
				['t', 'scrutiny-v0.8.1-test'],
				['t', 'scrutiny-metadata-test'],
				['i', 'cc:ANSSI-CC-2024/26'],
				['k', 'cc']
			],
			content: 'S3SSE2A — synthetic test-corpus metadata'
		},
		generateSecretKey()
	) as unknown as NostrEvent;
}

describe('admission boundary (admitBatch)', () => {
	it('admits a full-mirror event ON and drops it as not-scrutiny OFF', () => {
		if (includeTestTags()) {
			const [stored] = admitBatch([], [testMetadata()]);
			expect(stored).toBeDefined();
			for (const tag of ['scrutiny-fabric-test', 'scrutiny-v0.8.1-test', 'scrutiny-metadata-test']) {
				expect(stored.tags.some((t) => t[0] === 't' && t[1] === tag)).toBe(true);
			}
			for (const tag of ['scrutiny-fabric', 'scrutiny-v0.8.1', 'scrutiny-metadata']) {
				expect(stored.tags.some((t) => t[0] === 't' && t[1] === tag)).toBe(true);
			}
			// Exactly-one invariants survive the rewrite (TAG-1/2/3): one of
			// each canonical among the six t values.
			const tts = stored.tags.filter((t) => t[0] === 't').map((t) => t[1]);
			expect(tts.filter((t) => t === 'scrutiny-fabric')).toHaveLength(1);
			expect(tts.filter((t) => t === 'scrutiny-v0.8.1')).toHaveLength(1);
			expect(tts.filter((t) => t === 'scrutiny-metadata')).toHaveLength(1);
		} else {
			expect(admitBatch([], [testMetadata()])).toEqual([]);
		}
	});
});

describe('rewriteIncomingTags', () => {
	it('is idempotent and never doubles canonical tags (flag ON)', () => {
		if (!includeTestTags()) return;
		const [stored] = admitBatch([], [testMetadata()]);
		const before = [...stored.tags];
		rewriteIncomingTags(stored);
		expect(stored.tags).toEqual(before);
	});

	it('leaves non-mirror -test t values alone (not every -test is scrutiny)', () => {
		if (!includeTestTags()) return;
		const event = testMetadata();
		event.tags.push(['t', 'hot-test']);
		rewriteIncomingTags(event);
		expect(event.tags.some((t) => t[0] === 't' && t[1] === 'hot')).toBe(false);
	});

	it('returns the event untouched when the flag is off', () => {
		if (includeTestTags()) return;
		const event = testMetadata();
		const tagsBefore = structuredClone(event.tags);
		rewriteIncomingTags(event);
		expect(event.tags).toEqual(tagsBefore);
	});
});

describe('relay filter extension', () => {
	it('spans both namespaces ON; byte-identical to core OFF', () => {
		if (includeTestTags()) {
			expect(extendWithTest(['scrutiny-product', 'scrutiny-metadata'])).toEqual([
				'scrutiny-product',
				'scrutiny-metadata',
				'scrutiny-product-test',
				'scrutiny-metadata-test'
			]);
			expect(filterWithTestTags(indexerFilter('cc:ANSSI-CC-2024/26'))['#t']).toEqual([
				'scrutiny-fabric',
				'scrutiny-fabric-test'
			]);
			expect(filterWithTestTags(patchesReferencing('ab'.repeat(32)))['#t']).toEqual([
				'scrutiny-patch',
				'scrutiny-patch-test'
			]);
		} else {
			const core = indexerFilter('cc:ANSSI-CC-2024/26');
			expect(filterWithTestTags(core)).toEqual(core);
			expect(extendWithTest(['scrutiny-fabric'])).toEqual(['scrutiny-fabric']);
		}
	});
});
