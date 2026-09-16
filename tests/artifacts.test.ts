// Artifact extraction trust gate (issue #77): the FileRef seam is the ONE
// deterministic judge of "files" for drawer, node, and card. Cases cover
// the adversarial review's conditions: scheme allowlist (javascript: can
// never index, on EITHER tier), tier merge with imeta-wins-per-url,
// one-artifact-per-paragraph attach, label-drop (never truncate), CRLF/BOM
// cleanup, id stability (fnv1a over the URL, not ordinals), and the
// extension whitelist on bare legacy URLs.

import { describe, expect, it } from 'vitest';
import { artifactCount, artifactsOf, artifactIcon } from '../src/lib/artifacts';
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

describe('imeta tier', () => {
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
			sizeText: '897440 bytes',
			sha256: 'a'.repeat(64),
			provenance: 'imeta'
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
		expect(artifactsOf(e)[0]).toMatchObject({ sha256: undefined, sizeText: undefined });
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
		expect(artifactsOf(e)[0]?.sizeText).toBe('10 bytes');
	});
});

describe('content-legacy tier', () => {
	it('the BSI security-target shape: labeled lines + one-artifact paragraph inherits siblings', () => {
		const content = [
			'Security target for BSI-DSZ-CC-1185-2023.',
			'',
			'PDF: https://www.commoncriteriaportal.org/files/1185b_pdf.pdf',
			'Pages: 59',
			'Size: 897440 bytes',
			'SHA-256: ' + '2c136d2dc8ae3acc46dd11150fa4649b76b74e4c731a4c6ca28f805a701c02b1'
		].join('\n');
		const arts = artifactsOf(event(content));
		expect(arts).toHaveLength(1);
		expect(arts[0]).toMatchObject({
			label: 'PDF',
			sizeText: '59 pages · 897440 bytes',
			sha256: '2c136d2dc8ae3acc46dd11150fa4649b76b74e4c731a4c6ca28f805a701c02b1',
			provenance: 'content'
		});
	});

	it('a paragraph with TWO artifacts leaves siblings unattributed rather than wrong', () => {
		const content = 'PDF: https://one.pdf\nCSV: https://two.csv\nSHA-256: ' + 'b'.repeat(64);
		const arts = artifactsOf(event(content));
		expect(arts).toHaveLength(2);
		expect(arts.every((a) => a.sha256 === undefined)).toBe(true);
	});

	it('a labeled line carrying TWO urls drops entirely (never guess)', () => {
		const e = event('Reference: https://one.pdf and https://two.pdf');
		expect(artifactsOf(e)).toEqual([]);
	});

	it('bare urls need the artifact extension — an advisory citing its homepage is NOT a file (the #77 bug)', () => {
		expect(artifactsOf(event('https://www.niit.gov.cn/advisory'))).toEqual([]);
		const f = artifactsOf(event('https://cert.example.com/download/maintenance-raw.csv'));
		expect(f).toHaveLength(1);
	});

	it('CRLF/BOM/ZWSP/quotes/trailing punctuation are stripped before matching', () => {
		const content = '\uFEFF"PDF: https://files.example/st.pdf,";\u200B';
		expect(artifactsOf(event(content))).toHaveLength(1);
		expect(artifactsOf(event(content))[0]?.url).toBe('https://files.example/st.pdf');
	});

	it('javascript: in a labeled tier line is rejected by the same allowlist', () => {
		expect(artifactCount(event('PDF: javascript:alert(1)'))).toBe(0);
	});
});

describe('tier merge + identity', () => {
	it('imeta wins on URL collision; legacy fills only the fields imeta left open', () => {
		const content = 'PDF: https://records.example/st.pdf\nSize: 897440 bytes';
		const e = event(content, [['imeta', 'url https://records.example/st.pdf', 'alt Tagged Security Target']]);
		const arts = artifactsOf(e);
		expect(arts).toHaveLength(1);
		expect(arts[0]).toMatchObject({ provenance: 'imeta', label: 'Tagged Security Target', sizeText: '897440 bytes' });
	});

	it('ids are URL-stable (fnv1a), independent of the descriptor\'s paragraph position', () => {
		const a = artifactsOf(event('PDF: https://records.example/st.pdf'));
		const b = artifactsOf(event('Notes first.\n\nPDF: https://records.example/st.pdf\nSize: 1 bytes'));
		expect(a[0]?.id).toBe(b[0]?.id);
	});

	it('fragment-only differences dedupe; query differences do not (the query names the file)', () => {
		const e = event('PDF: https://a.example/f.pdf#x\nPDF: https://a.example/f.pdf#y');
		expect(artifactsOf(e)).toHaveLength(1);
		const e2 = event('PDF: https://a.example/f.pdf?v=1\nPDF: https://a.example/f.pdf?v=2');
		expect(artifactsOf(e2)).toHaveLength(2);
	});
});

describe('icon buckets', () => {
	it('extension beats mime (vocabulary token vs the file\'s own name)', () => {
		expect(artifactIcon({ url: 'https://a/st.pdf', mime: 'text/plain' })).toBeDefined();
		expect(String(artifactIcon({ url: 'https://a/f.csv', mime: undefined }))).not.toEqual(String(artifactIcon({ url: 'https://a/st.pdf', mime: undefined })));
	});
});
