// Guard (issue #39): every tooltip goes through KeyHint. A native `title=`
// cannot be styled, wrapped predictably or opened from the keyboard, so none
// may come back on an HTML element. Parsed with the Svelte compiler, not a
// regex: tags carry `=>` and `{...}` that defeat text matching. Component
// props named `title` (our own capitalised components) and <title> elements
// (head, SVG) are not tooltips and are not RegularElement attributes.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory()
			? svelteFiles(path)
			: path.endsWith('.svelte')
				? [path]
				: [];
	});
}

type Node = { type?: string; name?: string; attributes?: Node[] } & Record<string, unknown>;

function hasNativeTitle(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(hasNativeTitle);
	if (node === null || typeof node !== 'object') return false;
	const n = node as Node;
	if (
		(n.type === 'RegularElement' || n.type === 'SvelteElement') &&
		n.attributes?.some((a) => a.type === 'Attribute' && a.name === 'title')
	) {
		return true;
	}
	return Object.values(n).some(hasNativeTitle);
}

describe('no native title tooltips', () => {
	it('no .svelte file puts title= on an HTML element', () => {
		const offenders = svelteFiles(SRC)
			.filter((file) => hasNativeTitle(parse(readFileSync(file, 'utf8'), { modern: true }).fragment))
			.map((file) => relative(SRC, file));
		expect(offenders).toEqual([]);
	});

	it('the detector finds a title attribute (so an empty list means something)', () => {
		const ast = parse('<button onclick={() => go()} title="x">a</button>', { modern: true });
		expect(hasNativeTitle(ast.fragment)).toBe(true);
		const clean = parse('<svg><title>x</title></svg><Foo title="y" />', { modern: true });
		expect(hasNativeTitle(clean.fragment)).toBe(false);
	});
});
