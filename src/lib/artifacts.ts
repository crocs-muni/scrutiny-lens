/**
 * Artifacts (issue #77, ruling 2026-09-16): a record's FILES — the PDF /
 * CSV / archive descriptors it carries. "Files" was three independent
 * guesses ("any URL in content" counted an advisory's homepage as a
 * deliverable; the binding ledger counted every binding as one).
 *
 * One seam, two tiers, MERGED — imeta-first with parsed legacy fallback:
 *
 *  - imeta tier (nostr tags): ["imeta", "url <https>", "m <mime>",
 *    "x <hex-64>", "size <digits>", "alt <label>"]. Core-owned parsing
 *    tracked on scrutiny-fabric-tools#79; until it lands this file owns
 *    the same grammar (multi-entry tags, first `url` wins).
 *  - content-legacy tier: records that spell the descriptor as prose
 *    lines ("PDF: https://…) — the owner's BSI security-target shape.
 *    Conservative by construction: whole-line anchored, stripped of
 *    CRLF/BOM/zero-width chars/quotes/trailing punctuation; bare URLs
 *    need an artifact-extension whitelist; a labeled line containing
 *    TWO urls is rejected whole (never guess which was meant); sibling
 *    descriptors (SHA-256:, Size:, Pages:) attach ONLY to a sole
 *    artifact in their paragraph — a shared paragraph leaves them
 *    unattributed rather than wrong (one-artifact rule).
 *
 * Never-lie (spec §2): no fetches, no inference, no AI. Scheme allowlist
 * `http(s)` is enforced AT PARSE TIME (a `javascript:`/`data:` URL can
 * never reach render, on either tier). Every optional field that fails
 * validation is OMITTED, not defaulted (truncated labels would lie).
 * Malformed-but-uintelligible input yields zero artifacts — an honest
 * empty Files count, never an error row.
 *
 * Surface rule: every one of node's files-count, drawer Files rows, and
 * card footer come from `artifactsOf` — no third judgement of "URL in
 * content" is allowed to live anywhere else (the #77 root cause).
 */

import {
	IconFileTypeCsv,
	IconFileTypeDoc,
	IconFileTypeDocx,
	IconFileTypePdf,
	IconFileTypeXls,
	IconFileTypeXml,
	IconFileTypeZip,
	IconFileUnknown,
	type Icon
} from '@tabler/icons-svelte';
import type { NostrEvent } from '$lib/fabric';

export interface ArtifactRef {
	/** `eventId#fnv1a32(normalized-url)` — content byte order can differ
	 * between relay fetches; the URL is the artifact's identity, not its
	 * char position (review: ordinal ids were refetch-fragile). */
	id: string;
	url: string;
	/** Descriptor label — ≤40 chars (legacy) / ≤60 (`alt`); longer labels
	 * are DROPPED, never truncated (a cropped name lies harder). Mono. */
	label: string | undefined;
	/** `m` value, vocabulary-only: drives the icon bucket. */
	mime: string | undefined;
	/** Composed from descriptor siblings, verbatim: "59 pages · 897440 bytes"—
	 * only what the record literally stated; missing parts stay out. */
	sizeText: string | undefined;
	/** Validated 64-hex sha-256 (rendering mid-clips it, never alters it). */
	sha256: string | undefined;
	provenance: 'imeta' | 'content';
}

/** Bare-URL legacy lines need an artifact extension, or an advisory's
 * every citation becomes a "file" (the bug the owner caught). */
const ARTIFACT_EXT = /\.(pdf|csv|zip|docx?|xlsx?|json|xml|txt)(?:[?#].*)?$/i;

/** Classifier for the icon bucket: extension beats MIME (MIME is a
 * vocabulary token, extension is the file's own name). */
export function artifactIcon(a: Pick<ArtifactRef, 'url' | 'mime'>): Icon {
	const ext = a.url.match(ARTIFACT_EXT)?.[1]?.toLowerCase();
	const mime = a.mime?.toLowerCase() ?? '';
	if (ext === 'pdf' || mime.includes('pdf')) return IconFileTypePdf;
	if (ext === 'csv' || mime.includes('csv')) return IconFileTypeCsv;
	if (ext === 'doc' || ext === 'docx') return ext === 'docx' ? IconFileTypeDocx : IconFileTypeDoc;
	if (ext === 'xls' || ext === 'xlsx') return IconFileTypeXls; // no xlsx glyph in tabler's set
	if (ext === 'zip' || mime.includes('zip')) return IconFileTypeZip;
	if (ext === 'xml' || mime.includes('xml')) return IconFileTypeXml;
	// json/txt + anything unknown: one honest glyph, never a wrong family.
	return IconFileUnknown;
}

/** fnv-1a 32-bit, hex8 — URL-stable artifact id portion. */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** Dedupe key: same descriptor may travel with/without fragment, case, or a
 * trailing `/`. Identity does NOT strip query params — they name the file. */
function normalizeUrl(url: string): string {
	const u = new URL(url);
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	u.protocol = u.protocol.toLowerCase();
	let s = u.href;
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** http(s) ONLY — the allowlist at parse time, so no tier can hand a
 * javascript:/data: string to a render path (review finding, HIGH). */
function httpUrl(raw: string): URL | null {
	try {
		const u = new URL(raw);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
	} catch {
		return null;
	}
}

/** Lines arrive hostile: CRLF, BOM, zero-width internals, surrounding
 * quotes, trailing sentence punctuation on the URL. */
function cleanLine(line: string): string {
	return line
		.replace(/[\uFEFF\u200B\u200C\u200D]/g, '')
		.trim()
		.replace(/^["'“”(\[«]+/, '')
		.replace(/["'“”)\]»]+$/, '');
}

function stripUrlPunct(url: string): string {
	return url.replace(/[.,;:"'“”)\]»]+$/u, '');
}

const VALID_SHA = /^[0-9a-f]{64}$/i;

interface Draft {
	url: string;
	label?: string;
	mime?: string;
	sizeText?: string;
	sha256?: string;
	provenance: 'imeta' | 'content';
}

/** imeta grammar (NIP-92 family): `"key value"` entries, split on FIRST
 * space. url required and http(s); everything else decorate-or-omit. */
function imetaTier(event: NostrEvent): Draft[] {
	const drafts: Draft[] = [];
	for (const tag of event.tags) {
		if (tag[0] !== 'imeta') continue;
		const kv = new Map<string, string>();
		let urlRaw: string | undefined;
		for (const entry of tag.slice(1)) {
			const sp = entry.indexOf(' ');
			if (sp <= 0) continue;
			const key = entry.slice(0, sp).toLowerCase();
			const value = entry.slice(sp + 1).trim();
			if (key === 'url' && urlRaw === undefined) urlRaw = value;
			else if (!kv.has(key)) kv.set(key, value);
		}
		if (urlRaw === undefined) continue;
		const url = httpUrl(stripUrlPunct(urlRaw.trim())) ;
		if (url === null) continue; // no valid url → the tag contributes NOTHING
		const size = kv.get('size');
		const sha = kv.get('x');
		const alt = kv.get('alt');
		drafts.push({
			url: url.href,
			label: alt !== undefined && alt.length > 0 && alt.length <= 60 ? alt : undefined,
			mime: kv.get('m'),
			sizeText: size !== undefined && /^\d+$/.test(size) ? `${size} bytes` : undefined,
			sha256: sha !== undefined && VALID_SHA.test(sha) ? sha : undefined,
			provenance: 'imeta'
		});
	}
	return drafts;
}

const LABELED_URL = /^([^\n:;]{1,40}):\s*(https?:\/\/\S+)\s*$/;
const TWO_URLS = /https?:\/\/\S+.*https?:\/\/\S+/;
const SIBLING = {
	sha: /^(?:SHA-?256)\s*:\s*([0-9a-f]{64})\b/i,
	size: /^(?:Size)\s*:\s*([\d,]+)\s*bytes?\b/i,
	pages: /^(?:Pages)\s*:\s*(\d+)\b/i
};

/** Content-legacy tier: prose descriptor paragraphs. Conservative rules
 * (review): exactly-one-artifact-per-paragraph for sibling attach, whole-
 * line anchoring, 2-URL labeled lines rejected, scheme allowlist. */
function contentTier(event: NostrEvent): Draft[] {
	const drafts: Draft[] = [];
	const paragraphs = event.content.split(/\n{2,}/);
	for (const para of paragraphs) {
		const lines = para.split('\n').map(cleanLine).filter((l) => l.length > 0);
		const here: Draft[] = [];
		const siblings: { sha: string[]; size: string[]; pages: string[] } = { sha: [], size: [], pages: [] };
		for (const line of lines) {
			if (TWO_URLS.test(line)) continue; // ambiguous by construction — drop the whole line
			const labeled = line.match(LABELED_URL);
			if (labeled !== null) {
				const url = httpUrl(stripUrlPunct(labeled[2]));
				if (url !== null) {
					here.push({ url: url.href, label: labeled[1].trim() || undefined, provenance: 'content' });
					continue;
				}
			}
			// Bare URL line: only if it names an artifact by extension.
			const bare = httpUrl(stripUrlPunct(line));
			if (bare !== null && ARTIFACT_EXT.test(bare.pathname)) {
				here.push({ url: bare.href, provenance: 'content' });
				continue;
			}
			// Sibling descriptors, only meaningfully attachable below.
			const sha = line.match(SIBLING.sha);
			if (sha !== null) { siblings.sha.push(sha[1]); continue; }
			const size = line.match(SIBLING.size);
			if (size !== null) { siblings.size.push(size[1].replaceAll(',', '')); continue; }
			const pages = line.match(SIBLING.pages);
			if (pages !== null) { siblings.pages.push(pages[1]); }
		}
		// One-artifact paragraph rule: only a sole artifact may inherit the
		// paragraph's siblings — a shared paragraph leaves them unattributed
		// (never guess which file a hash belongs to).
		if (here.length === 1) {
			const composed = [
				siblings.pages.length > 0 ? `${siblings.pages[0]} pages` : undefined,
				siblings.size.length > 0 ? `${siblings.size[0]} bytes` : undefined
			].filter(Boolean) as string[];
			here[0].sizeText = composed.length > 0 ? composed.join(' · ') : undefined;
			here[0].sha256 = siblings.sha.length > 0 ? siblings.sha[0] : undefined;
		}
		drafts.push(...here);
	}
	return drafts;
}

/** A record's artifacts, merged across tiers: imeta tags first (their
 * fields win on a URL collision), legacy text filling any URL imeta
 * never named; colliding legacy descriptors keep contributing the
 * fields imeta didn't state. Nothing invented; dedupe by normalized URL. */
export function artifactsOf(event: NostrEvent): ArtifactRef[] {
	const byUrl = new Map<string, Draft>();
	for (const d of imetaTier(event)) byUrl.set(normalizeUrl(d.url), d);
	for (const d of contentTier(event)) {
		const key = normalizeUrl(d.url);
		const existing = byUrl.get(key);
		// imeta wins the identity; legacy fills only what imeta left open.
		if (existing === undefined) byUrl.set(key, d);
		else {
			existing.label ??= d.label;
			existing.sizeText ??= d.sizeText;
			existing.sha256 ??= d.sha256;
		}
	}
	return [...byUrl.values()].map((d) => ({
		id: `${event.id}#${fnv1a(normalizeUrl(d.url))}`,
		url: d.url,
		label: d.label,
		mime: d.mime,
		sizeText: d.sizeText,
		sha256: d.sha256,
		provenance: d.provenance
	}));
}

/** Deterministic semantic for "files": exact artifact count of a record —
 * every surface calls this; nothing counts URLs anywhere else (issue #77). */
export function artifactCount(event: NostrEvent): number {
	return artifactsOf(event).length;
}
