import { describe, expect, it } from 'vitest';
import { parseBlocks } from '$lib/chat/markdown';

/* GFM tables in the chat blockifier (issue #177). The parser is a subset
 * by design — citation pills are Svelte components between runs — but a
 * table is a block type, not pipe-shaped paragraph text. */

describe('parseBlocks — GFM tables', () => {
	it('parses a table with header alignment and rows', () => {
		const blocks = parseBlocks(
			'Intro\n\n| Claim | Observed | Verdict |\n| :--- | :---: | ---: |\n| JavaCard | 2.2.2 | match |\n| RSA | supported | match |\n'
		);
		expect(blocks).toEqual([
			{ kind: 'paragraph', text: 'Intro' },
			{
				kind: 'table',
				header: ['Claim', 'Observed', 'Verdict'],
				align: ['left', 'center', 'right'],
				rows: [
					['JavaCard', '2.2.2', 'match'],
					['RSA', 'supported', 'match']
				]
			}
		]);
	});

	it('keeps escaped pipes and inline-code pipes inside one cell', () => {
		const blocks = parseBlocks('| A | B |\n|---|---|\n| a \\| b | `x|y` |\n');
		expect(blocks).toEqual([
			{
				kind: 'table',
				header: ['A', 'B'],
				align: [null, null],
				rows: [['a | b', '`x|y`']]
			}
		]);
	});

	it('accepts one-hyphen GFM delimiters', () => {
		const blocks = parseBlocks('| a | b |\n|:-|-:|\n| 1 | 2 |');
		expect(blocks[0]).toMatchObject({
			kind: 'table',
			align: ['left', 'right'],
			rows: [['1', '2']]
		});
	});

	it('keeps a double-backtick code span with a pipe in one cell', () => {
		const blocks = parseBlocks('| A | B |\n|---|---|\n| ``x|y`` | z |');
		expect(blocks[0]).toMatchObject({ kind: 'table', rows: [['``x|y``', 'z']] });
	});

	it('ends the body at a following block start even when it contains a pipe', () => {
		const blocks = parseBlocks('| A | B |\n|---|---|\n| 1 | 2 |\n- note | pipe\n');
		expect(blocks).toEqual([
			{
				kind: 'table',
				header: ['A', 'B'],
				align: [null, null],
				rows: [['1', '2']]
			},
			{ kind: 'bullets', items: ['note | pipe'] }
		]);
	});

	it('does not table a mismatched header/delimiter column count', () => {
		expect(parseBlocks('| a |\n|---|---|\n| 1 | 2 |')).toEqual([
			{ kind: 'paragraph', text: '| a |\n|---|---|\n| 1 | 2 |' }
		]);
	});

	it('supports a one-column table only when the delimiter row is piped', () => {
		expect(parseBlocks('| A |\n|---|\n| 1 |')).toEqual([
			{
				kind: 'table',
				header: ['A'],
				align: [null],
				rows: [['1']]
			}
		]);
		// A bare `---` is a horizontal rule, not a one-column delimiter.
		expect(parseBlocks('a | b\n---')).toEqual([{ kind: 'paragraph', text: 'a | b\n---' }]);
	});

	it('keeps multiple paragraphs as separate blocks (the crash shape)', () => {
		expect(parseBlocks('first\n\nsecond')).toEqual([
			{ kind: 'paragraph', text: 'first' },
			{ kind: 'paragraph', text: 'second' }
		]);
	});

	it('pads short rows to the header width', () => {
		const blocks = parseBlocks('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n');
		expect(blocks[0]).toMatchObject({ kind: 'table', rows: [['1', '2', '']] });
	});
});
