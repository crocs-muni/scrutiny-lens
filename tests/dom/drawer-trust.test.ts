// Trusted-publisher admission on the surfaces (ADR 0004, spec §3/§4/§9):
// a record reached through a trusted publisher's binding SAYS so in the
// drawer (neutral inset, never a pill), a direct-trust record says nothing,
// and the empty trusted view names how many records sit outside the list
// instead of reading as "your relays have nothing".

import 'fake-indexeddb/auto';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DetailDrawerHarness from './DetailDrawerHarness.svelte';
import ResultsEmpty from '$lib/components/ui/ResultsEmpty.svelte';
import { shell } from '$lib/shell.svelte';
import type { Dossier } from '$lib/dossier';
import type { NostrEvent } from '$lib/fabric';

// The strip's chip resolves a kind-0 profile; no relay I/O in a DOM test.
vi.mock('$lib/net/profiles', () => ({
	getProfile: () => Promise.resolve(undefined),
	profileClaim: () => 'unasked'
}));

const PUBLISHER = 'cc'.repeat(32);

const subject: NostrEvent = {
	id: 'md1',
	pubkey: 'bb'.repeat(32),
	created_at: 1_700_000_000,
	kind: 1,
	tags: [],
	content: 'metadata\n',
	sig: '00'.repeat(64)
};

const reached: Dossier = {
	subject,
	subjectType: 'metadata',
	retracted: false,
	title: { text: 'CVE-2017-15361', interpreted: false },
	snippet: undefined,
	identifiers: [],
	publisher: subject.pubkey,
	createdAt: subject.created_at,
	counts: { summary: 0, history: 0, files: 0 },
	content: { text: 'metadata\n', banner: null },
	history: [],
	files: [],
	admittedVia: {
		bindingId: 'b1',
		publisherPubkey: PUBLISHER,
		otherTitle: 'Infineon TPM'
	}
};

describe('DetailDrawer trusted-publisher provenance', () => {
	afterEach(() => {
		shell.drawerSection = 'summary';
	});

	it('a binding-reached subject renders the neutral strip with the other title', () => {
		const { container } = render(DetailDrawerHarness, { props: { dossier: reached } });

		const strip = container.querySelector('[data-admitted-via]');
		expect(strip).not.toBeNull();
		const text = strip?.textContent ?? '';
		expect(text).toContain('Reached through');
		expect(text).toMatch(/binding\s+to/);
		expect(text).toContain('Infineon TPM');
	});

	it('a direct subject renders no strip at all', () => {
		const { container } = render(DetailDrawerHarness, {
			props: { dossier: { ...reached, admittedVia: null } }
		});

		expect(container.querySelector('[data-admitted-via]')).toBeNull();
		expect(container.textContent).not.toContain('Reached through');
	});
});

describe('ResultsEmpty trusted view', () => {
	it('names the outside count and offers Manage trusted publishers', async () => {
		const onManageTrust = vi.fn();
		render(ResultsEmpty, {
			props: {
				filtered: false,
				relayCount: 3,
				trusted: true,
				outsideCount: 7,
				onManageTrust,
				onAskDifferently: () => {}
			}
		});

		expect(screen.getByText('Nothing from your trusted publishers matched')).toBeTruthy();
		expect(screen.getByText(/7 records on your relays sit outside/)).toBeTruthy();
		expect(screen.getByText('Searched 3 relays · widen the relay list in Settings (Ctrl+,)')).toBeTruthy();

		const manage = screen.getByRole('button', { name: 'Manage trusted publishers' });
		await fireEvent.click(manage);
		expect(onManageTrust).toHaveBeenCalledOnce();
	});
});
