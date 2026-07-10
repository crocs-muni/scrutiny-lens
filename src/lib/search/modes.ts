import type { DetectedQuery, NDKFilter, SearchFilter } from './types.js';

export const KNOWN_INDEXER_PREFIXES = new Set([
	'cve',
	'cwe',
	'cpe',
	'purl',
	'cc',
	'fips',
	'fcc-id',
	'swid',
	'gtin',
	'pp',
	'vendor',
	'scheme'
]);

export const TYPE_TAGS = {
	all: 'scrutiny-fabric',
	product: 'scrutiny-product',
	metadata: 'scrutiny-metadata',
	binding: 'scrutiny-binding',
	patch: 'scrutiny-patch'
} as const;

export function detectMode(query: string): DetectedQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: 'browse' };

	const lower = trimmed.toLowerCase();

	// CVE identifier
	const cveMatch = trimmed.match(/^CVE-\d{4}-\d{4,}$/i);
	if (cveMatch) {
		return { mode: 'identifier', identifier: `cve:${cveMatch[0].toUpperCase()}` };
	}

	// Known indexer prefix, e.g. "cc:BSI-...", "vendor:Infineon"
	const indexerMatch = trimmed.match(/^([a-z][a-z0-9-]*):(.+)$/i);
	if (indexerMatch) {
		const prefix = indexerMatch[1].toLowerCase();
		if (KNOWN_INDEXER_PREFIXES.has(prefix)) {
			return { mode: 'identifier', identifier: `${prefix}:${indexerMatch[2].trim()}` };
		}
	}

	return { mode: 'freetext', search: trimmed };
}

export function searchFilter(detected: DetectedQuery, type: string | null = null): NDKFilter {
	const base: NDKFilter = { kinds: [1], limit: 50 };

	if (detected.mode === 'browse') {
		base['#t'] = [type ? TYPE_TAGS[type as keyof typeof TYPE_TAGS] ?? type : TYPE_TAGS.all];
		return base;
	}

	if (detected.mode === 'identifier') {
		base['#i'] = [detected.identifier!];
		if (type) base['#t'] = [TYPE_TAGS[type as keyof typeof TYPE_TAGS] ?? type];
		return base;
	}

	// freetext
	base.search = detected.search;
	if (type) base['#t'] = [TYPE_TAGS[type as keyof typeof TYPE_TAGS] ?? type];
	return base;
}

export function toSearchFilter(filter: NDKFilter): SearchFilter {
	if (filter['#i']) return { mode: 'identifier', identifier: filter['#i'][0], types: filter['#t'] };
	if (filter.search) return { mode: 'freetext', search: filter.search, types: filter['#t'] };
	return { mode: 'browse', types: filter['#t'] };
}
