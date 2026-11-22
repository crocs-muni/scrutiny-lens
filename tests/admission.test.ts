/**
 * Trusted-publisher admission, enforced by fabric's oracle (issue #214, spec §6, ADR 0004).
 *
 * The curated list is only the *default view*: chain construction and traversal always run on
 * the full observed set (TR-7), and `computeAdmission` filters afterwards. These five cases pin
 * that seam end to end — direct authorship, Binding reach, TR-5 root chains, TR-6's exclusion of
 * foreign patches, and DEL-5/TR-4 retraction — without any app wiring.
 *
 * Events are the minimal wire shape the SDK's own `admit` fixtures use: ids derived from a label,
 * deterministic `created_at`, a placeholder `sig`. `computeAdmission` reads kind, pubkey and tags
 * only, so no signing is involved and the suite stays node-only.
 */
import { describe, expect, it } from 'vitest';
import {
	computeAdmission,
	trustedView,
	trustSymbol,
	type NostrEvent,
	type TrustProvider
} from '$lib/fabric';

const ROOT = 'a'.repeat(64);
const FOREIGN = 'b'.repeat(64);

/** A 64-hex id derived from a label, so every scenario is replayable byte for byte. */
function idOf(label: string): string {
	let hash = 0;
	for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return `${hash.toString(16).padStart(8, '0')}${label.replace(/[^a-f0-9]/gi, '')}`
		.padEnd(64, '0')
		.slice(0, 64);
}

/** The base `t` tags every SCRUTINY event carries (TAG-1/TAG-2/TAG-3). */
function baseTags(type: string): string[][] {
	return [
		['t', 'scrutiny-fabric'],
		['t', 'scrutiny-v0.8.1'],
		['t', `scrutiny-${type}`]
	];
}

function event(
	label: string,
	type: string,
	overrides: Partial<NostrEvent> = {}
): NostrEvent {
	return {
		id: idOf(label),
		pubkey: ROOT,
		created_at: 1_714_000_000,
		kind: 1,
		tags: baseTags(type),
		content: `Fixture: ${label}.`,
		sig: '0'.repeat(128),
		...overrides
	};
}

/** A Binding links exactly one Product (`root`) to one Metadata (`link`). */
function binding(
	label: string,
	rootId: string,
	linkId: string,
	overrides: Partial<NostrEvent> = {}
): NostrEvent {
	return event(label, 'binding', {
		tags: [...baseTags('binding'), ['e', rootId, '', 'root'], ['e', linkId, '', 'link']],
		...overrides
	});
}

/** A Patch replying into a root's chain; `root` and `reply` carry NIP-10 markers. */
function patch(
	label: string,
	rootId: string,
	replyId: string,
	overrides: Partial<NostrEvent> = {}
): NostrEvent {
	return event(label, 'patch', {
		tags: [
			...baseTags('patch'),
			['e', rootId, '', 'root', ROOT],
			['e', replyId, '', 'reply', ROOT]
		],
		...overrides
	});
}

/** A NIP-09 kind 5; NIP-09/DEL-1 honours it only when its pubkey matches the target's author. */
function deletion(label: string, targetIds: readonly string[], pubkey = ROOT): NostrEvent {
	return {
		id: idOf(label),
		pubkey,
		created_at: 1_714_000_000,
		kind: 5,
		tags: targetIds.map((id) => ['e', id]),
		content: 'Retracting.',
		sig: '0'.repeat(128)
	};
}

/** The branded predicate `computeAdmission` consumes — same shape the app's store supplies. */
function trust(trusted: readonly string[]): TrustProvider {
	const set = new Set(trusted);
	return {
		[trustSymbol]: true,
		isTrusted: (pubkey) => set.has(pubkey),
		version: 0,
		deltaSince: () => null
	};
}

describe('TR-2 — a Product by a trusted key is admitted directly', () => {
	it('admits it with direct-trust and shows it in the trusted view', () => {
		const root = event('product', 'product');
		const index = computeAdmission([root], trust([ROOT]));

		expect(index.reasons[root.id]).toEqual(['direct-trust']);
		expect(trustedView(index).isAdmitted(root.id)).toBe(true);
	});
});

describe('TR-4 — a trusted Binding admits its endpoints, whatever their authors', () => {
	it('admits untrusted-authored endpoints with binding:<id>', () => {
		const root = event('product', 'product', { pubkey: FOREIGN });
		const link = event('metadata', 'metadata', { pubkey: FOREIGN });
		const edge = binding('binding', root.id, link.id, { pubkey: ROOT });

		const index = computeAdmission([root, link, edge], trust([ROOT]));
		const view = trustedView(index);

		expect(index.reasons[link.id]).toEqual([`binding:${edge.id}`]);
		expect(index.reasons[root.id]).toEqual([`binding:${edge.id}`]);
		expect(view.isAdmitted(link.id)).toBe(true);
		expect(view.isAdmitted(root.id)).toBe(true);
	});
});

describe('TR-6 — a foreign patch is never admitted through its root', () => {
	it('leaves an untrusted author’s patch out of the trusted view', () => {
		const root = event('product', 'product');
		const foreign = patch('foreign-patch', root.id, root.id, { pubkey: FOREIGN });

		const index = computeAdmission([root, foreign], trust([ROOT]));

		expect(index.reasons[root.id]).toEqual(['direct-trust']);
		expect(index.reasons[foreign.id]).toBeUndefined();
		expect(trustedView(index).isAdmitted(foreign.id)).toBe(false);
	});
});

describe('TR-5 — a root-author patch joins the root chain', () => {
	it('admits the patch as direct-trust plus root-chain:<id>', () => {
		const root = event('product', 'product');
		const ownPatch = patch('root-patch', root.id, root.id);

		const index = computeAdmission([root, ownPatch], trust([ROOT]));

		expect(index.reasons[ownPatch.id]).toEqual(['direct-trust', `root-chain:${root.id}`]);
		expect(trustedView(index).isAdmitted(ownPatch.id)).toBe(true);
	});
});

describe('DEL-5/TR-4 — retracting a Binding revokes the admission it conferred', () => {
	it('stops admitting both endpoints once the Binding’s author deletes it', () => {
		const root = event('product', 'product', { pubkey: FOREIGN });
		const link = event('metadata', 'metadata', { pubkey: FOREIGN });
		const edge = binding('binding', root.id, link.id, { pubkey: ROOT });
		const retraction = deletion('retract-binding', [edge.id], ROOT);

		const before = trustedView(computeAdmission([root, link, edge], trust([ROOT])));
		expect(before.isAdmitted(link.id)).toBe(true);
		expect(before.isAdmitted(root.id)).toBe(true);

		const after = computeAdmission([root, link, edge, retraction], trust([ROOT]));
		expect(after.reasons[link.id]).toBeUndefined();
		expect(after.reasons[root.id]).toBeUndefined();
		expect(trustedView(after).isAdmitted(link.id)).toBe(false);
		expect(trustedView(after).isAdmitted(root.id)).toBe(false);
	});
});
