// Issue #160: the results rail died with `each_key_duplicate` on a 548-card
// run — a page-level crash, not a warning. The rail's keyed each is
// `railLive ? viewCards : investigation.skeletons as card (card.id)`, so the
// assertion here renders the same key expression over the real derivation:
// a duplicated id must paint one block instead of throwing.

import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import type { ProductCard } from '$lib/pipeline/cards';
import RailFixture from './RailFixture.svelte';

function event(id: string): NostrEvent {
	return {
		id,
		pubkey: 'a'.repeat(64),
		created_at: 1_700_000_000,
		kind: 1,
		tags: [
			['t', 'scrutiny-fabric'],
			['t', 'scrutiny-product'],
			['i', 'cve:CVE-2017-15361']
		],
		sig: '00'.repeat(64),
		content: ''
	};
}

const card = (ev: NostrEvent): ProductCard => ({
	id: ev.id,
	typeTag: 'scrutiny-product',
	createdAt: ev.created_at,
	pubkey: ev.pubkey,
	title: 'cve:CVE-2017-15361',
	snippet: undefined,
	identifiers: ['cve:CVE-2017-15361'],
	retracted: false,
	boundMetadata: 0,
	files: 0,
	updates: 0,
	contentStart: '',
	interpreted: false
});

describe('results rail keyed each (issue #160)', () => {
	it('a duplicated card id renders one block instead of throwing', () => {
		const a = event('a1'.repeat(32));
		render(RailFixture, { props: { events: [a], cards: [card(a), card(a)] } });
		expect(screen.getAllByTestId('rail-card')).toHaveLength(1);
	});
});
