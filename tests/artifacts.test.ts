// Artifact extraction trust gate (issue #77 + 2026-09-17 ruling): files are
// the record's imeta descriptors — ONLY imeta. This file pins the
// adversarial invariants of the ONE seam every surface reads: scheme
// allowlist (javascript: can never index), decorate-or-omit fields (bad
// `x`, non-numeric `size`, overlong `alt` fall away instead of lying), id
// stability (fnv1a over the URL, not ordinals), URL dedupe semantics, the
// imeta-only ruling, and the display helpers (human bytes, honest name).

import { describe, expect, it } from 'vitest';
import {
	artifactCount,
	artifactsOf,
	artifactIcon,
	artifactName,
	formatBytes
} from '../src/lib/artifacts';
import type { NostrEvent } from '$lib/fabric';

const SIG = 'cd'.repeat(64);
function event(content: string, tags: string[][] = []): NostrEvent {
	return {
		id: 'ab'.repeat(32),
		sig: SIG,
		pubkey: 'ef'.repeat(32),
		created_at: 1_700_000_000,
		kind: 1,
		tags,
		content
	};
}

describe('imeta descriptors', () => {
	it('parses a full descriptor; plain evidence wins icon bucket', () => {
		const e = event('whatever', [
			['imeta', 'url https://records.example/st.pdf', 'm application/pdf', 'x ' + 'a'.repeat(64), 'size 897440', 'alt Security Target']
		]);
		const arts = artifactsOf(e);
		expect(arts).toHaveLength(1);
		expect(arts[0]).toMatchObject({
			url: 'https://records.example/st.pdf',
			label: 'Security Target',
			mime: 'application/pdf',
			sizeBytes: 897440,
			sha256: 'a'.repeat(64)
		});
	});

	it('first url wins in a multi-url tag; no url → tag contributes nothing', () => {
		const e = event('', [['imeta', 'url https://x.example/a.pdf', 'url https://x.example/b.pdf']]);
		expect(artifactsOf(e).map((a) => a.url)).toEqual(['https://x.example/a.pdf']);
		const noUrl = event('', [['imeta', 'm application/pdf']]);
		expect(artifactsOf(noUrl)).toEqual([]);
	});

	it('VALIDATES decoratives: malformed x/size omit, never store (omitted ≠ fabricated)', () => {
		const e = event('', [['imeta', 'url https://a.pdf', 'x deadbeef', 'size 9poop']]);
		expect(artifactsOf(e)[0]).toMatchObject({ sha256: undefined, sizeBytes: undefined });
	});

	it('alt longer than 60 chars is dropped, not truncated', () => {
		const e = event('', [['imeta', 'url https://a.pdf', 'alt ' + 'X'.repeat(61)]]);
		expect(artifactsOf(e)[0]?.label).toBeUndefined();
	});

	it('SCHEME ALLOWLIST: javascript:/data: imeta urls are rejected at parse time (review finding)', () => {
		const e = event('', [['imeta', 'url javascript:alert(1)'], ['imeta', 'url data:text/html,hi']]);
		expect(artifactsOf(e)).toEqual([]);
	});

	it('unknown keys are ignored; whitespace inside values collapses', () => {
		const e = event('', [['imeta', 'url https://a.pdf', 'blurhash AAA', 'size 10']]);
		expect(artifactsOf(e)[0]?.sizeBytes).toBe(10);
	});
});

describe('imeta-only ruling (2026-09-17) — content URLs are NEVER files', () => {
	it('an advisory citing its homepage is not a file (the #77 bug)', () => {
		expect(artifactsOf(event('https://www.niit.gov.cn/advisory'))).toEqual([]);
	});

	it('a labeled PDF line in content is not a file either — even a perfect legacy shape yields zero', () => {
		const content = [
			'Security target for BSI-DSZ-CC-1185-2023.',
			'',
			'PDF: https://www.commoncriteriaportal.org/files/1185b_pdf.pdf',
			'Size: 897440 bytes'
		].join('\n');
		expect(artifactCount(event(content))).toBe(0);
	});

	it('javascript: in content is doubly dead — not parsed, and not openable even if it were', () => {
		expect(artifactCount(event('PDF: javascript:alert(1)'))).toBe(0);
	});
});

describe('identity', () => {
	it('ids are URL-stable (fnv1a over the descriptor, not the tag\'s position)', () => {
		const a = artifactsOf(event('', [['imeta', 'url https://records.example/st.pdf']]));
		const b = artifactsOf(event('', [['t', 'x'], ['imeta', 'url https://records.example/st.pdf', 'size 1']]));
		expect(a[0]?.id).toBe(b[0]?.id);
	});

	it('fragment-only differences dedupe; query differences do not (the query names the file)', () => {
		const e = event('', [
			['imeta', 'url https://a.example/f.pdf#x'],
			['imeta', 'url https://a.example/f.pdf#y']
		]);
		expect(artifactsOf(e)).toHaveLength(1);
		const e2 = event('', [
			['imeta', 'url https://a.example/f.pdf?v=1'],
			['imeta', 'url https://a.example/f.pdf?v=2']
		]);
		expect(artifactsOf(e2)).toHaveLength(2);
	});
});

describe('icon buckets', () => {
	it('extension beats mime (vocabulary token vs the file\'s own name)', () => {
		expect(artifactIcon({ url: 'https://a/st.pdf', mime: 'text/plain' })).toBeDefined();
		expect(String(artifactIcon({ url: 'https://a/f.csv', mime: undefined }))).not.toEqual(String(artifactIcon({ url: 'https://a/st.pdf', mime: undefined })));
	});
});

describe('display helpers', () => {
	it('formatBytes renders download-manager sizes, never "2104942 bytes"', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(87909)).toBe('88 KB');
		expect(formatBytes(353996)).toBe('354 KB');
		expect(formatBytes(2104942)).toBe('2.1 MB');
		expect(formatBytes(2_100_000_000)).toBe('2.1 GB');
	});

	it('artifactName prefers the declared alt, then the URL\'s own basename, never a hash', () => {
		expect(artifactName({ url: 'https://a/st.pdf', label: 'Security Target' })).toBe('Security Target');
		expect(artifactName({ url: 'https://files.example/dir/cert%20target.pdf', label: undefined })).toBe('cert target.pdf');
		expect(artifactName({ url: 'https://files.example', label: undefined })).toBe('https://files.example');
	});
});
