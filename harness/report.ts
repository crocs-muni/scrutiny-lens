// The local report: one HTML file next to the PNGs, opened from disk.
// No external asset, font or CDN: a file:// page has to render without a
// network, and the harness must not depend on one (spec §8: all assets
// self-hosted).
//
// Everything large (text lines, error strings) lives in full.json; the page
// shows what a person needs to judge the change.

import type { CompareResult, SceneComparison } from './compare.ts';

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const MAX_TEXT_LINES = 400;

function textBlock(title: string, lines: readonly string[], kind: 'added' | 'removed'): string {
	if (lines.length === 0) return '';
	const shown = lines.slice(0, MAX_TEXT_LINES);
	const rest = lines.length - shown.length;
	return `<div class="textdiff ${kind}"><h4>${title} (${lines.length})</h4><pre>${shown
		.map((line) => escapeHtml(line))
		.join('\n')}${rest > 0 ? `\n… ${rest} more in full.json` : ''}</pre></div>`;
}

function errorList(title: string, items: readonly string[]): string {
	if (items.length === 0) return '';
	return `<div class="textdiff added"><h4>${title} (${items.length})</h4><pre>${items
		.map((item) => escapeHtml(item))
		.join('\n')}</pre></div>`;
}

function figure(src: string | null, label: string): string {
	if (src === null) return `<figure class="missing"><div class="blank">${label}: none</div></figure>`;
	// No lazy loading: without intrinsic dimensions the grid collapses to zero
	// height until decode, which makes a first paint look like a broken report.
	return `<figure><a href="${src}"><img src="${src}" alt="${escapeHtml(label)}"></a><figcaption>${label}</figcaption></figure>`;
}

function entrySection(entry: SceneComparison): string {
	const stats: string[] = [];
	if (entry.verdict === 'changed' || entry.verdict === 'unchanged') {
		stats.push(`${entry.pixels.toLocaleString('en-US')} px (${(entry.ratio * 100).toFixed(4)}%)`);
	}
	if (entry.bounds !== null) stats.push(`bbox ${entry.bounds.join(', ')}`);
	if (entry.sizeMismatch !== null) stats.push(`base ${entry.sizeMismatch[0]} vs head ${entry.sizeMismatch[1]}`);
	if (entry.factsChanged) stats.push('facts changed');
	const diffText = [
		textBlock('text added', entry.textAdded, 'added'),
		textBlock('text removed', entry.textRemoved, 'removed'),
		errorList('new page errors', entry.newPageErrors),
		errorList('new console errors', entry.newConsoleErrors),
		errorList('new failed requests', entry.newFailedRequests),
		errorList('expect text now missing', entry.newMissingText),
		errorList('scene run() error', entry.newSceneError === null ? [] : [entry.newSceneError])
	]
		.filter((block) => block !== '')
		.join('\n');
	return `<section id="${entry.id}">
  <h2>${escapeHtml(entry.scene)} <span class="theme">${entry.theme}</span> <span class="badge ${entry.verdict}">${entry.verdict}</span></h2>
  <p class="stats">${escapeHtml(stats.join(' · '))}</p>
  <div class="frames">
    ${figure(entry.images.base, 'before')}
    ${figure(entry.images.head, 'after')}
    ${figure(entry.images.diff, 'diff')}
  </div>
  ${diffText}
</section>`;
}

function sha(meta: CompareResult['base']['meta']): string {
	if (meta === null) return 'unknown';
	const state = meta.lens.dirty === true && meta.sourceSha === null ? ' (dirty)' : '';
	return `${(meta.sourceSha ?? meta.lens.sha)?.slice(0, 12) ?? 'unknown'}${state}`;
}

function browser(result: CompareResult): string {
	const base = result.base.meta?.chromium ?? 'unknown';
	const head = result.head.meta?.chromium ?? 'unknown';
	return base === head ? escapeHtml(base) : `${escapeHtml(base)} → ${escapeHtml(head)}`;
}

export function renderCompareReport(result: CompareResult): string {
	const warnings =
		result.warnings.length === 0
			? ''
			: `<div class="warnings"><strong>Warnings</strong><ul>${result.warnings
					.map((warning) => `<li>${escapeHtml(warning)}</li>`)
					.join('')}</ul></div>`;
	const nav = result.entries
		.map(
			(entry) =>
				`<a class="chip ${entry.verdict}" href="#${entry.id}">${escapeHtml(entry.id)}</a>`
		)
		.join(' ');
	const score = result.score;
	const noise = result.noise.file
		? `${result.noise.entries} entries (${result.noise.checksum?.slice(0, 12) ?? 'no checksum'})`
		: 'missing (floor 0)';
	const meta = result.base.meta ?? result.head.meta;
	const siblings = meta === null
		? 'unknown'
		: Object.entries({ fabricTools: meta.fabricTools, designSystem: meta.designSystem })
				.map(([name, state]) => `${name} ${state.sha?.slice(0, 8) ?? 'missing'}${state.dirty === true ? '*' : ''}`)
				.join(', ');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(result.base.label)} → ${escapeHtml(result.head.label)}</title>
<style>
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 18%, transparent); }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1800px; padding: 24px; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h4 { font-size: 12px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
.theme { font: 12px ui-monospace, 'Cascadia Mono', monospace; opacity: .6; }
.badge, .chip { border-radius: 999px; padding: 2px 10px; font: 12px ui-monospace, 'Cascadia Mono', monospace; text-decoration: none; color: inherit; background: var(--line); }
.badge.unchanged, .chip.unchanged { background: #16a34a22; color: #15803d; }
.badge.changed, .chip.changed { background: #dc262622; color: #b91c1c; }
.badge.new, .chip.new { background: #2563eb22; color: #1d4ed8; }
.badge.removed, .chip.removed { background: #6b728022; color: #4b5563; }
.badge.size-mismatch, .chip.size-mismatch { background: #9333ea22; color: #7e22ce; }
nav { margin: 12px 0 20px; display: flex; gap: 6px; flex-wrap: wrap; }
.summary { display: flex; gap: 24px; flex-wrap: wrap; margin: 8px 0 16px; font: 13px ui-monospace, 'Cascadia Mono', monospace; }
.summary b { font-weight: 600; }
.warnings { border: 1px solid #d97706; background: #d9770622; border-radius: 8px; padding: 10px 14px; margin: 12px 0; }
.warnings ul { margin: 4px 0 0; padding-left: 20px; }
table { border-collapse: collapse; margin: 8px 0 20px; font: 12px ui-monospace, 'Cascadia Mono', monospace; }
th, td { text-align: left; padding: 3px 14px 3px 0; vertical-align: top; }
th { opacity: .6; font-weight: 500; }
section { border-top: 1px solid var(--line); padding: 18px 0; }
.stats { font: 12px ui-monospace, 'Cascadia Mono', monospace; opacity: .75; margin: 0 0 10px; }
.frames { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
figure { margin: 0; }
figure img { width: 100%; border: 1px solid var(--line); border-radius: 4px; background: #8080801a; }
figcaption { font: 11px ui-monospace, 'Cascadia Mono', monospace; opacity: .6; margin-top: 4px; }
.blank { border: 1px dashed var(--line); border-radius: 4px; min-height: 120px; display: grid; place-items: center; font-size: 12px; opacity: .6; }
.textdiff { margin-top: 12px; }
.textdiff pre { margin: 0; max-height: 320px; overflow: auto; padding: 8px 10px; border-radius: 6px; font: 12px ui-monospace, 'Cascadia Mono', monospace; white-space: pre-wrap; }
.textdiff.added pre { background: #16a34a18; }
.textdiff.removed pre { background: #dc262618; }
footer { margin-top: 24px; font-size: 12px; opacity: .6; }
@media (max-width: 900px) { .frames { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>${escapeHtml(result.base.label)} → ${escapeHtml(result.head.label)} <span class="badge ${result.verdict}">${result.verdict}</span></h1>
<p class="stats">base ${sha(result.base.meta)} · head ${sha(result.head.meta)} · chromium ${browser(result)}</p>
<div class="summary">
  <span><b>${score.changedScenes}</b> changed</span>
  <span><b>${score.changedPixels.toLocaleString('en-US')}</b> px</span>
  <span><b>+${score.addedTextLines}</b> text</span>
  <span><b>−${score.removedTextLines}</b> text</span>
  <span><b>${score.newErrors}</b> errors</span>
</div>
${warnings}
<table>
  <tr><th>noise floor</th><td>${escapeHtml(noise)}</td></tr>
  <tr><th>siblings</th><td>${escapeHtml(siblings)}</td></tr>
  <tr><th>node / playwright</th><td>${escapeHtml(`${meta?.node ?? 'unknown'} / ${meta?.playwright ?? 'unknown'}`)}</td></tr>
  <tr><th>T0</th><td>${escapeHtml(String(meta?.t0 ?? 'unknown'))}</td></tr>
  <tr><th>fixtures</th><td>${escapeHtml(
		Object.entries(meta?.fixtures ?? {})
			.map(([name, digest]) => `${name} ${digest.slice(0, 8)}`)
			.join(', ') || 'none'
	)}</td></tr>
  <tr><th>detail</th><td><a href="full.json">full.json</a> · <a href="summary.json">summary.json</a></td></tr>
</table>
<nav>${nav}</nav>
${result.entries.map(entrySection).join('\n')}
<footer>Generated by harness compare · relative image paths · no network assets</footer>
</body>
</html>
`;
}
