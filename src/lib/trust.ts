// Trusted-publisher admission (issue #214, spec §2/§3, ADR 0004).
//
// The curated list is an admission policy, not a facet and not a badge. This
// module owns the list file's shape and the mechanical set arithmetic; the
// trust decision itself stays in fabric's `computeAdmission` (TR-2…TR-7),
// applied after chain resolution. Local add/remove keys are plain pubkeys —
// their labels are machine tokens derived from the key, never user prose
// (issue #214's out-of-scope line).
import { z } from 'zod';
import { publisherNpub, publisherToken } from './publisher';
import { trustSymbol, type TrustProvider } from '$lib/fabric';
import seed from './data/trusted-publishers.json';

export interface TrustedPublisher {
	pubkey: string;
	label: string;
}

export interface TrustedListFile {
	version: number;
	updated: string;
	source?: string;
	publishers: TrustedPublisher[];
}

const HEX_64 = /^[0-9a-f]{64}$/;

const trustedPublisherSchema = z.object({
	pubkey: z.string().regex(HEX_64, 'a publisher key is 64 lowercase hex characters'),
	label: z.string().trim().min(1).max(80)
});

const trustedListSchema = z.object({
	version: z.number().int().positive(),
	updated: z.string().min(1),
	source: z.string().min(1).optional(),
	publishers: z.array(trustedPublisherSchema)
});

/** First occurrence wins: the file is the reviewed order, so a duplicate
 * pubkey later in the array is a copy-paste slip, not a second publisher. */
function dedupe(publishers: readonly TrustedPublisher[]): TrustedPublisher[] {
	const seen = new Set<string>();
	const out: TrustedPublisher[] = [];
	for (const publisher of publishers) {
		if (seen.has(publisher.pubkey)) continue;
		seen.add(publisher.pubkey);
		out.push({ pubkey: publisher.pubkey, label: publisher.label });
	}
	return out;
}

/** Validate a list file from disk (or, later, a relay event) without trusting
 * its shape. Throws on a malformed file: a bad admission policy must fail
 * loudly at load, never silently admit everything. */
export function parseTrustedList(raw: unknown): TrustedListFile {
	const parsed = trustedListSchema.safeParse(raw);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('; ');
		throw new Error(`Invalid trusted publisher list: ${details}`);
	}
	return { ...parsed.data, publishers: dedupe(parsed.data.publishers) };
}

/** The reviewed list shipped with the build, parsed through the same gate as
 * any future loader. Module load fails if the committed file is malformed. */
export const BUNDLED_TRUSTED: TrustedListFile = parseTrustedList(seed);

/**
 * Effective admission list: base ∪ added, minus removed.
 *
 * Base order first, then added order; a pubkey appears once. A base entry and
 * an added entry for the same key keep the reviewed base label, and removal
 * wins over both.
 */
export function effectiveTrusted(
	base: readonly TrustedPublisher[],
	added: readonly string[],
	removed: readonly string[]
): TrustedPublisher[] {
	const removedKeys = new Set(removed.map((pubkey) => pubkey.trim().toLowerCase()));
	const seen = new Set<string>();
	const out: TrustedPublisher[] = [];

	for (const publisher of base) {
		const key = publisher.pubkey.trim().toLowerCase();
		if (!key || removedKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push({ pubkey: key, label: publisher.label });
	}

	for (const candidate of added) {
		const key = candidate.trim().toLowerCase();
		if (!key || removedKeys.has(key) || seen.has(key)) continue;
		seen.add(key);
		// Locally added keys carry no user label (issue #214 out of scope), so
		// the machine-made npub token is the honest label; a non-pubkey entry
		// gets no label rather than a fabricated one.
		out.push({ pubkey: key, label: HEX_64.test(key) ? publisherToken(publisherNpub(key)) : '' });
	}

	return out;
}

/**
 * The branded bridge fabric's admission oracle expects. `version` changes
 * with the effective list; `deltaSince` returns null because the whole list
 * is local and cheap, and D16/D21 make a full rebuild the legal answer.
 */
export function createTrustProvider(
	isTrusted: (pubkey: string) => boolean,
	version: number
): TrustProvider {
	return {
		[trustSymbol]: true as const,
		isTrusted,
		version,
		deltaSince: () => null
	};
}
