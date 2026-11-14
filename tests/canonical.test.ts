import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { buildPatch } from '@scrutiny-fabric/core';
import type { NostrEvent } from '../src/lib/fabric';
import { canonicalContentOf } from '../src/lib/ai/canonical';
import { createCitationRegistry } from '../src/lib/ai/citationRegistry';

/**
 * #163 — quotes verify against RESOLVED content. These fixtures build a real
 * root-author patch through the SDK builder so the chain the gate consults is
 * the same one `core.resolve()` reports to every other surface.
 */

const ROOT_BEFORE = 'title: old\nbody text\n';
const ROOT_AFTER = 'title: new\nbody text\n';

/** A patched product chain: root + one root-author patch, both from `key`. */
function patchedProduct(): { root: NostrEvent; patch: NostrEvent; events: NostrEvent[] } {
	const key = generateSecretKey();
	const base = { kind: 1, created_at: 1_700_000_000 };
	const root = finalizeEvent(
		{
			...base,
			content: ROOT_BEFORE,
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-v0.8.1'],
				['t', 'scrutiny-product'],
				['i', 'cve:CVE-2024-1634'],
				['k', 'cve'],
			],
		},
		key
	) as NostrEvent;

	const { template } = buildPatch({
		root: { id: root.id, relay: '', authorHint: root.pubkey },
		reply: { id: root.id, relay: '', authorHint: root.pubkey },
		before: ROOT_BEFORE,
		after: ROOT_AFTER,
		createdAt: 1_700_000_100,
	});
	const patch = finalizeEvent(
		{
			...base,
			created_at: 1_700_000_100,
			content: template.content,
			tags: template.tags.map((tag) => [...tag]),
		},
		key
	) as NostrEvent;

	return { root, patch, events: [root, patch] };
}

/** An unpatched product: nothing can replace its text. */
function unpatchedProduct(): { root: NostrEvent; events: NostrEvent[] } {
	const root = finalizeEvent(
		{
			kind: 1,
			created_at: 1_700_000_000,
			content: 'title: solo\nbody text\n',
			tags: [
				['t', 'scrutiny-fabric'],
				['t', 'scrutiny-v0.8.1'],
				['t', 'scrutiny-product'],
			],
		},
		generateSecretKey()
	) as NostrEvent;
	return { root, events: [root] };
}

describe('canonicalContentOf (#163)', () => {
	it('returns the patched text, never the raw event content', () => {
		const { root, events } = patchedProduct();
		expect(canonicalContentOf(root.id, events)).toBe(ROOT_AFTER);
		expect(canonicalContentOf(root.id, events)).not.toBe(root.content);
	});

	it('returns the event content byte-for-byte when the chain carries no patch', () => {
		const { root, events } = unpatchedProduct();
		expect(canonicalContentOf(root.id, events)).toBe(root.content);
	});

	it('returns content for an event that cannot carry a chain (BD-9: retract, never patch)', () => {
		const binding = finalizeEvent(
			{
				kind: 1,
				created_at: 1_700_000_000,
				content: 'card → certificate',
				tags: [
					['t', 'scrutiny-fabric'],
					['t', 'scrutiny-v0.8.1'],
					['t', 'scrutiny-binding'],
					['e', 'aa'.repeat(32), '', 'root', ''],
					['e', 'bb'.repeat(32), '', 'link', ''],
				],
			},
			generateSecretKey()
		) as NostrEvent;
		expect(canonicalContentOf(binding.id, [binding])).toBe(binding.content);
	});

	it('returns undefined for a root that is not in the admitted set', () => {
		const { root } = unpatchedProduct();
		expect(canonicalContentOf(root.id, [])).toBeUndefined();
	});
});

describe('citation gate (#163)', () => {
	it('rejects a quote that only the pre-patch text carries', () => {
		const { root, events } = patchedProduct();
		const registry = createCitationRegistry();
		const n = registry.next(root.id);
		const stale = registry.resolve(n, events, 'title: old');
		expect(stale.ok).toBe(true);
		if (!stale.ok) return;
		expect(stale.citation.verified).toBe(false);
	});

	it('accepts a quote the current (patched) text carries', () => {
		const { root, events } = patchedProduct();
		const registry = createCitationRegistry();
		const n = registry.next(root.id);
		const current = registry.resolve(n, events, 'title: new');
		expect(current.ok).toBe(true);
		if (!current.ok) return;
		expect(current.citation.verified).toBe(true);
	});

	it('leaves an unpatched record verifying exactly as before', () => {
		const { root, events } = unpatchedProduct();
		const registry = createCitationRegistry();
		const n = registry.next(root.id);
		const hit = registry.resolve(n, events, 'title: solo');
		expect(hit.ok).toBe(true);
		if (!hit.ok) return;
		expect(hit.citation.verified).toBe(true);
	});

	it('refuses to resolve a pinned id the admitted set no longer holds', () => {
		const { root } = patchedProduct();
		const registry = createCitationRegistry();
		const n = registry.next(root.id);
		expect(registry.resolve(n, [], 'title: old').ok).toBe(false);
	});
});
