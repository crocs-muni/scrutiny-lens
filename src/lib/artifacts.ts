/**
 * Artifacts (issue #77 + owner ruling 2026-09-17): a record's FILES are its
 * `imeta` descriptors. Only imeta. Content URLs are NOT files — an advisory
 * citing its homepage, a certificate registry link, a prose reference, none
 * of those are deliverables (the #77 bug was "any URL in content"; the
 * interim legacy parse tier was retired by the 2026-09-17 ruling).
 *
 * imeta grammar (NIP-92 family): `"key value"` entries, split on FIRST
 * space. `url` required and http(s); unknown keys ignored; malformed
 * decorate-or-omit fields (bad `x`, non-numeric `size`, overlong `alt`)
 * fall away instead of poisoning the row — malformed-but-unintelligible
 * input yields zero artifacts, an honest empty Files count, never an
 * error row.
 *
 * Surface rule: every one of node's files-count, drawer Files rows, and
 * card footer come from `artifactsOf` — no second judgement of "URL in
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
	/** `alt` descriptor — ≤60 chars; longer labels are DROPPED, never
	 * truncated (a cropped name lies harder). */
	label: string | undefined;
	/** `m` value, vocabulary-only: drives the icon bucket. */
	mime: string | undefined;
	/** `size` value as a byte number. Formatting is the SURFACE's job
	 * (formatBytes) — the descriptor stores facts, never prose. */
	sizeBytes: number | undefined;
	/** Validated 64-hex sha-256 (rendering mid-clips it, never alters it). */
	sha256: string | undefined;
}

/** Known file extensions for the icon bucket — extension beats MIME
 * (MIME is a vocabulary token, extension is the file's own name). */
const ARTIFACT_EXT = /\.(pdf|csv|zip|docx?|xlsx?|json|xml|txt)(?:[?#].*)?$/i;

/** Classifier for the icon bucket. */
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

/** Human byte sizes (2026-09-17 ruling — nobody reads "2104942 bytes"):
 * SI like a download manager — B exact, KB whole, MB/GB one decimal. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '';
	if (n < 1000) return `${n} B`;
	if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
	return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

/** Display name for an artifact row: the `alt` the record declared, else
 * the file's own basename from the URL (percent-decoded), else the URL
 * itself (the renderer mid-clips). A name the file carries beats a hash. */
export function artifactName(a: Pick<ArtifactRef, 'url' | 'label'>): string {
	if (a.label !== undefined) return a.label;
	try {
		const base = new URL(a.url).pathname.split('/').filter(Boolean).pop();
		if (base !== undefined && base.length > 0) return decodeURIComponent(base);
	} catch { /* url was validated http(s) at parse; defensive only */ }
	return a.url;
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
 * trailing `/`. Identity does NOT strip query params — they name the file
 * (NIP-92 mirrors: same file at several URLs is ONE file). */
function normalizeUrl(url: string): string {
	const u = new URL(url);
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	u.protocol = u.protocol.toLowerCase();
	let s = u.href;
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** http(s) ONLY — the allowlist at parse time, so no descriptor can hand a
 * javascript:/data: string to a render path (review finding, HIGH). */
function httpUrl(raw: string): URL | null {
	try {
		const u = new URL(raw);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
	} catch {
		return null;
	}
}

function stripUrlPunct(url: string): string {
	return url.replace(/[.,;:"'“”)\]»]+$/u, '');
}

const VALID_SHA = /^[0-9a-f]{64}$/i;

interface Draft {
	url: string;
	label?: string;
	mime?: string;
	sizeBytes?: number;
	sha256?: string;
}

/** imeta grammar: `"key value"` entries, split on FIRST space. url required
 * and http(s); everything else decorate-or-omit. */
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
		const url = httpUrl(stripUrlPunct(urlRaw.trim()));
		if (url === null) continue; // no valid url → the tag contributes NOTHING
		const size = kv.get('size');
		const sha = kv.get('x');
		const alt = kv.get('alt');
		drafts.push({
			url: url.href,
			label: alt !== undefined && alt.length > 0 && alt.length <= 60 ? alt : undefined,
			mime: kv.get('m'),
			sizeBytes: size !== undefined && /^\d+$/.test(size) ? Number(size) : undefined,
			sha256: sha !== undefined && VALID_SHA.test(sha) ? sha : undefined
		});
	}
	return drafts;
}

/** A record's artifacts: its imeta descriptors, deduped by normalized URL
 * (document order wins the identity — deterministic across relay fetches).
 * Nothing invented; content never contributes. */
export function artifactsOf(event: NostrEvent): ArtifactRef[] {
	const byUrl = new Map<string, Draft>();
	for (const d of imetaTier(event)) {
		const key = normalizeUrl(d.url);
		if (!byUrl.has(key)) byUrl.set(key, d);
	}
	return [...byUrl.values()].map((d) => ({
		id: `${event.id}#${fnv1a(normalizeUrl(d.url))}`,
		url: d.url,
		label: d.label,
		mime: d.mime,
		sizeBytes: d.sizeBytes,
		sha256: d.sha256
	}));
}

/** Deterministic semantic for "files": exact artifact count of a record —
 * every surface calls this; nothing counts URLs anywhere else (issue #77). */
export function artifactCount(event: NostrEvent): number {
	return artifactsOf(event).length;
}
