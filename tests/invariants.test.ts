// Two hard rules from AGENTS.md that a regex over source text would get wrong.
//
// 1. t tags are kebab-case (AGENTS.md invariants, TAG-4): `scrutiny-product`,
//    never `scrutiny_product`. Snake_case tags still parse as Nostr tags, so
//    nothing at runtime complains — the failure is a filter that silently
//    matches nothing. Only string and template literals are inspected, so the
//    prose in comments and docs that names the bad form stays legal.
// 2. Every `{@html}` path sanitizes (AGENTS.md invariants; spec §6 engineering
//    guarantees: "chat markdown rendered via marked + DOMPurify (every HTML
//    path sanitized)"). Sanitizing is a property of the value that reaches the
//    sink, so the sink itself must be a call to one of `$lib/chat/markdown`'s
//    exports, imported in that same file. A `{@html}` on a variable that was
//    sanitized three screens away cannot be verified here, and it is exactly
//    the shape a later edit quietly breaks.
//
// Svelte files are parsed with the compiler, not matched textually: `{@html}`
// sits in markup where `{...}` and `=>` defeat regexes, and the import that
// permits the call lives in the instance script.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const SCRIPTS = join(ROOT, 'scripts');

// `scrutiny_` plus a lowercase letter is the snake_case tag form. Requiring
// that letter keeps prose that ends in `scrutiny_` legal while still catching
// every tag-shaped string.
const SNAKE_TAG = /scrutiny_[a-z]/;

// Extensionless, so a relative import (`../../chat/markdown`) and the `$lib`
// alias compare equal.
const MARKDOWN_MODULE = join(SRC, 'lib', 'chat', 'markdown');

type Node = { type?: string; start?: number } & Record<string, unknown>;

function walkAst(node: unknown, visit: (node: Node) => void, seen = new WeakSet<object>()): void {
	if (Array.isArray(node)) {
		for (const child of node) walkAst(child, visit, seen);
		return;
	}
	if (node === null || typeof node !== 'object' || seen.has(node)) return;
	seen.add(node);
	visit(node as Node);
	// Svelte 5 links parents during analysis; they are not part of the parsed
	// shape and would walk back up forever.
	for (const [key, value] of Object.entries(node)) {
		if (key !== 'parent') walkAst(value, visit, seen);
	}
}

function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
	return line;
}

/** file:line for every snake_case tag literal in a .ts source. Comments are
 * not literals, so a comment naming the bad form is not an offence. */
function tsTagOffenders(source: string, file: string): string[] {
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const offenders: string[] = [];
	const visit = (node: ts.Node): void => {
		const kind = node.kind;
		if (
			kind === ts.SyntaxKind.StringLiteral ||
			kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
			kind === ts.SyntaxKind.TemplateHead ||
			kind === ts.SyntaxKind.TemplateMiddle ||
			kind === ts.SyntaxKind.TemplateTail
		) {
			const text = (node as ts.LiteralLikeNode).text;
			if (SNAKE_TAG.test(text)) {
				offenders.push(`${relative(ROOT, file)}:${lineAt(source, node.getStart(parsed))} ${text}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return offenders;
}

/** file:line for every snake_case tag literal in a .svelte source: script
 * literals, template quasis, and markup attribute values (the compiler stores
 * those as `Text` nodes, not `Literal`s). Markup prose is text, not a literal,
 * so a paragraph mentioning the bad form is not an offence. */
function svelteTagOffenders(source: string, file: string): string[] {
	const offenders: string[] = [];
	const check = (text: string, start: number): void => {
		if (SNAKE_TAG.test(text)) offenders.push(`${relative(ROOT, file)}:${lineAt(source, start)} ${text}`);
	};
	walkAst(parse(source, { modern: true }), (node) => {
		if (node.type === 'Literal' && typeof node.value === 'string') check(node.value, node.start ?? 0);
		if (node.type === 'TemplateElement') {
			const value = node.value as { raw?: string; cooked?: string } | undefined;
			check(value?.cooked ?? value?.raw ?? '', node.start ?? 0);
		}
		if (node.type === 'Attribute' && Array.isArray(node.value)) {
			for (const part of node.value as Node[]) {
				if (part.type === 'Text' && typeof part.data === 'string') check(part.data, part.start ?? 0);
			}
		}
	});
	return offenders;
}

/** `$lib/chat/markdown` or a relative specifier that resolves to it. */
function isMarkdownModule(spec: unknown, file: string): boolean {
	if (typeof spec !== 'string') return false;
	if (spec === '$lib/chat/markdown') return true;
	if (!spec.startsWith('.')) return false;
	return resolve(dirname(file), spec).replace(/\.ts$/, '') === MARKDOWN_MODULE;
}

/** file:line for every `{@html}` whose expression is not a call to an
 * `$lib/chat/markdown` export imported by this file. */
function htmlSinkOffenders(source: string, file: string): string[] {
	const ast = parse(source, { modern: true });
	const allowed = new Set<string>();
	walkAst(ast, (node) => {
		if (node.type !== 'ImportDeclaration') return;
		const from = node.source as Node | undefined;
		if (!isMarkdownModule(from?.value, file)) return;
		for (const specifier of (node.specifiers ?? []) as Node[]) {
			// Bindings a call can name: the local alias, not the exported name.
			const local = specifier.local as Node | undefined;
			if (specifier.type === 'ImportSpecifier' && typeof local?.name === 'string') allowed.add(local.name);
		}
	});
	const offenders: string[] = [];
	walkAst(ast, (node) => {
		if (node.type !== 'HtmlTag') return;
		const expression = node.expression as Node | undefined;
		const callee = expression?.callee as Node | undefined;
		const safe =
			expression?.type === 'CallExpression' &&
			callee?.type === 'Identifier' &&
			typeof callee.name === 'string' &&
			allowed.has(callee.name);
		if (!safe) offenders.push(`${relative(ROOT, file)}:${lineAt(source, node.start ?? 0)}`);
	});
	return offenders;
}

function filesIn(dir: string, exts: string[]): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory()
			? filesIn(path, exts)
			: exts.some((ext) => name.endsWith(ext))
				? [path]
				: [];
	});
}

describe('invariants', () => {
	describe('kebab-case t tags', () => {
		it('no .ts or .svelte literal spells a tag with an underscore', () => {
			const tsFiles = [...filesIn(SRC, ['.ts']), ...filesIn(SCRIPTS, ['.ts'])];
			const svelteFiles = filesIn(SRC, ['.svelte']);
			// A walk that found nothing would pass the assertion below.
			expect(svelteFiles.length).toBeGreaterThan(0);
			expect(tsFiles.length).toBeGreaterThan(0);
			const offenders = [
				...tsFiles.flatMap((file) => tsTagOffenders(readFileSync(file, 'utf8'), file)),
				...svelteFiles.flatMap((file) => svelteTagOffenders(readFileSync(file, 'utf8'), file)),
			];
			expect(offenders).toEqual([]);
		});

		it('the detector flags a snake_case tag and passes kebab-case', () => {
			const tsFile = join(SRC, 'sample.ts');
			const svelteFile = join(SRC, 'sample.svelte');
			expect(tsTagOffenders('export const tag = "scrutiny_product";', tsFile)).toHaveLength(1);
			expect(svelteTagOffenders('<div class="scrutiny_product" />', svelteFile)).toHaveLength(1);
			expect(
				svelteTagOffenders('<script>const t = `prefix-${"x"} scrutiny_product`;</script>', svelteFile)
			).toHaveLength(1);
			expect(tsTagOffenders('export const tag = "scrutiny-product";', tsFile)).toEqual([]);
			expect(svelteTagOffenders('<div class="scrutiny-product" />', svelteFile)).toEqual([]);
		});

		it('the detector bites on an injected copy of a scanned file', () => {
			const file = join(SRC, 'lib', 'chat', 'markdown.ts');
			const source = `${readFileSync(file, 'utf8')}\nconst tag = 'scrutiny_product';\n`;
			expect(tsTagOffenders(source, file)).toHaveLength(1);
		});
	});

	describe('sanitized {@html} sinks', () => {
		it('every .svelte {@html} calls an $lib/chat/markdown export imported here', () => {
			const files = filesIn(SRC, ['.svelte']);
			const offenders = files.flatMap((file) => htmlSinkOffenders(readFileSync(file, 'utf8'), file));
			expect(offenders).toEqual([]);
			// The scan must actually reach the renderer; an empty walk would pass
			// every assertion above. ChatRichText owns both live sinks.
			const renderer = join(SRC, 'lib', 'components', 'chat', 'ChatRichText.svelte');
			expect(files).toContain(renderer);
			const source = readFileSync(renderer, 'utf8');
			expect(source).toContain('{@html inlineHtml(');
			expect(source).toContain('{@html escapeHtml(');
			expect(htmlSinkOffenders(source, renderer)).toEqual([]);
		});

		it('the detector flags an unsanitized sink and passes a sanitized one', () => {
			const file = join(SRC, 'lib', 'components', 'sample.svelte');
			const sanitized = [
				'<script lang="ts">',
				"	import { inlineHtml } from '$lib/chat/markdown';",
				'</script>',
				'{@html inlineHtml(text)}',
			].join('\n');
			expect(htmlSinkOffenders(sanitized, file)).toEqual([]);
			const relativeImport = sanitized.replace("'$lib/chat/markdown'", "'../chat/markdown'");
			expect(htmlSinkOffenders(relativeImport, file)).toEqual([]);

			expect(htmlSinkOffenders('{@html text}', file)).toHaveLength(1);
			expect(
				htmlSinkOffenders(
					'<script>import { marked } from \'marked\';</script>\n{@html marked.parse(text)}',
					file
				)
			).toHaveLength(1);
		});

		it('the detector bites on a de-sanitized copy of the renderer', () => {
			const file = join(SRC, 'lib', 'components', 'chat', 'ChatRichText.svelte');
			const source = readFileSync(file, 'utf8').replace('{@html escapeHtml(block.text)}', '{@html block.text}');
			expect(htmlSinkOffenders(source, file)).toHaveLength(1);
		});
	});
});
