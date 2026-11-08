import { describe, expect, it } from 'vitest';
import { parseBlocks } from '$lib/chat/markdown';

/* ATX headings in the chat blockifier (issue #185). Before this block kind
 * a model writing `## Summary` printed the hashes: HEADING only existed to
 * end a table. Heading text stays raw inline markdown here — the renderer
 * hands it to inlineHtml, like every other block body. */

describe('parseBlocks — ATX headings', () => {
	it('parses a level-2 heading', () => {
		expect(parseBlocks('## Findings')).toEqual([
			{ kind: 'heading', level: 2, text: 'Findings' }
		]);
	});

	it('honours the six-hash limit and keeps seven hashes as prose', () => {
		expect(parseBlocks('###### six')).toEqual([{ kind: 'heading', level: 6, text: 'six' }]);
		expect(parseBlocks('####### seven')).toEqual([
			{ kind: 'paragraph', text: '####### seven' }
		]);
	});

	it('ends an open bullet list', () => {
		expect(parseBlocks('- a\n- b\n## x')).toEqual([
			{ kind: 'bullets', items: ['a', 'b'] },
			{ kind: 'heading', level: 2, text: 'x' }
		]);
	});

	it('ends an open paragraph', () => {
		expect(parseBlocks('intro\n# Title')).toEqual([
			{ kind: 'paragraph', text: 'intro' },
			{ kind: 'heading', level: 1, text: 'Title' }
		]);
	});

	it('leaves a hash line inside a fence as code', () => {
		expect(parseBlocks('```md\n## x\n```')).toEqual([
			{ kind: 'code', lang: 'md', text: '## x' }
		]);
	});

	it('keeps inline markdown in the heading text for the renderer', () => {
		expect(parseBlocks('## **bold** title')).toEqual([
			{ kind: 'heading', level: 2, text: '**bold** title' }
		]);
	});

	it('stays paragraph text without a following space', () => {
		expect(parseBlocks('a # b')).toEqual([{ kind: 'paragraph', text: 'a # b' }]);
	});

	it('keeps a hash inside a table cell', () => {
		expect(parseBlocks('| A | B |\n|---|---|\n| # x | y |')).toEqual([
			{
				kind: 'table',
				header: ['A', 'B'],
				align: [null, null],
				rows: [['# x', 'y']]
			}
		]);
	});
});
