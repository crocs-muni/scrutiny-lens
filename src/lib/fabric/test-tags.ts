/**
 * SCRUTINY Fabric test-corpus seam (bootstrap 2026-09-16: jcalgtest re-tag +
 * sec-certs port). The ported corpora publish under a FULL-MIRROR t-tag
 * namespace — every canonical `scrutiny-foo` has a `scrutiny-foo-test` twin,
 * signed and stored as-is on the relay. Core knows nothing about the -test
 * namespace (and must not: the tools repo stays clean — lens owns this seam).
 *
 * Policy — NORMALIZE-AT-BOUNDARY. Gated by PUBLIC_INCLUDE_TEST_TAGS (see
 * src/lib/config.ts, default ON), every function here:
 *   - admission: maps `scrutiny-foo-test` t-tag values to `scrutiny-foo`
 *     BEFORE core validation/classification, by ADDING the canonical tag and
 *     KEEPING the test one — core then sees exactly one `scrutiny-fabric`,
 *     one version tag, one event-type tag (the -test twins match none of the
 *     grammars), while test-ness stays discoverable on the stored event;
 *   - relay filters: extends every `#t` array with the -test counterparts.
 *     NIP-01 arrays are OR, so one filter row spans both namespaces and the
 *     fetch paths need no second leg.
 * When the flag is OFF every function returns its input untouched — the
 * emitted filters and admitted events are byte-identical to core's.
 *
 * The normalization mutates the event's `tags` array IN PLACE (lens's
 * NostrEvent is the mutable wire shape, docs/types.md): admission functions
 * return only verdicts, so the object reference the pipeline stores must
 * itself carry both tag sets. The NIP-01 id is deliberately NOT recomputed —
 * relay-verified ids are computed over the as-signed -test tags, and
 * cross-event references (`e root` / `e link` / `e reply`) resolve by that
 * id; only the t-tags are extended, so references stay intact.
 */

import { FABRIC_TAG, EVENT_TYPE_TAGS, VERSION_TAG_PATTERN, type EventFilter } from '@scrutiny-fabric/core';
import { includeTestTags } from '$lib/config';
import type { NostrEvent } from './index';

/** The `-test` suffix every mirrored tag carries (full-mirror decision). */
export const TEST_TAG_SUFFIX = '-test';

/** Canonical tags whose values the test corpora mirror. Version tags are
 * matched by grammar, not enumerated — future protocol versions keep
 * working without touching this list. */
const MIRRORED_CANONICAL: Record<string, true> = Object.fromEntries(
	[FABRIC_TAG, ...Object.values(EVENT_TYPE_TAGS)].map((tag) => [tag, true])
);

function isMirroredCanonical(value: string): boolean {
	return MIRRORED_CANONICAL[value] === true || VERSION_TAG_PATTERN.test(value);
}

/** The `#t` array for one tag: [tag] alone when the flag is off; [tag,
 * `${tag}-test`] when on. */
export function tagSet(tag: string): string[] {
	return includeTestTags() ? [tag, `${tag}${TEST_TAG_SUFFIX}`] : [tag];
}

/** The `#t` array for every SCRUTINY event type (fullScanFilter's default). */
export function eventTypeTagSet(): string[] {
	return Object.values(EVENT_TYPE_TAGS).flatMap((tag) => tagSet(tag));
}

/** Extend a `#t` value array with each value's -test counterpart. NIP-01
 * arrays are OR — one filter row spans both namespaces; the OR semantics
 * also mean a relay that has only canonical events matches the same row.
 * Returns the SAME array reference when the flag is off (byte-identical). */
export function extendWithTest(values: readonly string[]): string[] {
	return includeTestTags() ? [...values, ...values.map((v) => `${v}${TEST_TAG_SUFFIX}`)] : (values as string[]);
}

/** Spread a core-built filter's `#t` with the -test counterparts. Returns
 * the SAME filter object when the flag is off (byte-identical). Core's
 * `EventFilter` is deeply readonly — the spread emits a fresh object only
 * when the flag is on, so off-path callers get core's original object. */
export function filterWithTestTags(filter: EventFilter): EventFilter {
	if (!includeTestTags() || filter['#t'] === undefined) return filter;
	return { ...filter, '#t': extendWithTest(filter['#t']) };
}

/**
 * Admission-boundary normalization: for every `t` tag value `X-test` whose
 * base `X` is a SCRUTINY tag (fabric / event-type / version grammar), add
 * `['t', X]` unless the canonical is already present. Idempotent — an
 * event passing through twice (admitBatch batch AND candidates, re-admission
 * across rounds) is never doubled, so core's "exactly one" invariants
 * (TAG-1/TAG-2/TAG-3) hold. Flag off: returns the event untouched.
 */
export function rewriteIncomingTags(event: NostrEvent): NostrEvent {
	if (!includeTestTags()) return event;
	const present = new Set(event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]));
	const additions: string[][] = [];
	for (const value of present) {
		if (!value.endsWith(TEST_TAG_SUFFIX)) continue;
		const canonical = value.slice(0, -TEST_TAG_SUFFIX.length);
		if (isMirroredCanonical(canonical) && !present.has(canonical)) {
			additions.push(['t', canonical]);
		}
	}
	if (additions.length > 0) event.tags.push(...additions);
	return event;
}

/**
 * The cache-boundary inverse: returns a copy of the event with each
 * ADMIT-added canonical twin REMOVED — tags whose -test counterpart is
 * present. The cache persists the as-signed form: an admitted event's id
 * was computed over the test-only tag list, and a normalized event stored
 * as-is re-enters later runs as a tamper (NIP-01 recompute mismatch — the
 * self-poisoning cache measured live 2026-09-17: poisoned cache-first
 * reads rejected every event and even blocked their relay-deduped twins).
 * Read-back strips identically, healing rows persisted before this fix.
 */
export function asSignedOnly(event: NostrEvent): NostrEvent {
	if (!includeTestTags()) return event;
	const present = new Set(event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]));
	const tags = event.tags.filter((tag) => {
		if (tag[0] !== 't') return true;
		const value = tag[1];
		return !(isMirroredCanonical(value) && present.has(`${value}${TEST_TAG_SUFFIX}`));
	});
	if (tags.length === event.tags.length) return event;
	return { ...event, tags };
}
