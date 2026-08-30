/**
 * W3 · AI pipeline core — deterministic tag-only projection skeleton.
 * Pure functions, NO LLM. Builds the honest degraded CardVM skeleton from an
 * event's tags when the AI layer is unavailable: title from the best
 * identifier, identifiers[], status 'unknown', metaSegments in fixed compose
 * order, and stats forwarded from the resolver input.
 *
 * Tag conventions (considered values = tag slots 1..n; slot 0 is the key):
 *   identifier  → identifier string                    (best: ccid > cve > cpe > d > name)
 *   ccid / cve / cpe / d / name  → identifier candidates (title = best)
 *   scheme      → scheme meta segment (e.g. "BSI · Germany")
 *   eal         → assurance segment (validated ^EAL[1-7]\+?$)
 */

import type { NostrEvent } from '../fabric';

export interface SkeletonStats {
	boundMetadata: number;
	attachments: number;
	updates: number;
}

export interface ProjectedSkeleton {
	entityId: string;
	title: string;
	identifiers: string[];
	status: 'unknown';
	metaSegments: string[];
	stats: SkeletonStats;
}

/** All value slots (1..n) of every tag carrying `key`. */
export function tagValues(event: NostrEvent, key: string): string[] {
	const out: string[] = [];
	for (const tag of event.tags) {
		if (tag[0] === key) {
			for (const v of tag.slice(1)) if (v) out.push(v);
		}
	}
	return out;
}

/** Identifier priority: ccid > cve > cpe > d > name. First non-empty wins. */
const IDENTIFIER_PRIORITY = ['ccid', 'cve', 'cpe', 'd', 'name'] as const;

export function bestIdentifier(event: NostrEvent): string | undefined {
	for (const key of IDENTIFIER_PRIORITY) {
		for (const v of tagValues(event, key)) {
			if (v) return v;
		}
	}
	return undefined;
}

const EAL = /^EAL[1-7]\+?$/;

/**
 * Compose the meta line in fixed order ["scheme flag+code", "EAL", "status"].
 * Skeleton status is always 'unknown', which is silently omitted (R-rule:
 * missing segments drop with their separators — never "N/A"/"—"). Scheme and
 * EAL are included when their tags are present and valid.
 */
export function composeMetaSegments(event: NostrEvent): string[] {
	const segments: string[] = [];
	const scheme = tagValues(event, 'scheme')[0];
	if (scheme) segments.push(scheme);
	const eal = tagValues(event, 'eal').find((v) => EAL.test(v));
	if (eal) segments.push(eal);
	return segments;
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

export function projectSkeleton(event: NostrEvent, stats: SkeletonStats): ProjectedSkeleton {
	const identifiers = tagValues(event, 'identifier').slice(0, 2);
	const head = event.content.trim().split(/\s+/)[0];
	const title = bestIdentifier(event) ?? identifiers[0] ?? (head || event.id);
	// Guarantee an identifier when the best identifier is a non-`identifier` tag.
	const all = dedupe([...tagValues(event, 'identifier'), ...(title ? [title] : [])]).slice(0, 2);
	const idents = all.length > 0 ? all : identifiers;
	return {
		entityId: event.id,
		title,
		identifiers: idents,
		status: 'unknown',
		metaSegments: composeMetaSegments(event),
		stats: { ...stats }
	};
}
