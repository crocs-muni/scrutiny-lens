// Detail drawer History rendering (issue #165): a reference outside the
// admitted set shows its id and an explicit state word — never a blank
// author, never 1 January 1970 — and the section count is the number of rows
// actually mounted (spec §2 rule 2).

import { render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import DetailDrawerHarness from './DetailDrawerHarness.svelte';
import { shell } from '$lib/shell.svelte';
import type { Dossier, HistoryRow } from '$lib/dossier';
import type { NostrEvent } from '$lib/fabric';

const AUTHOR = 'aa'.repeat(32);

const root: NostrEvent = {
	id: 'root',
	pubkey: AUTHOR,
	created_at: 1_700_000_000,
	kind: 1,
	tags: [],
	content: 'v1\n',
	sig: '00'.repeat(64)
};

const rows: HistoryRow[] = [
	{ id: 'root', observed: true, event: root, position: 0, state: 'root', canonical: true },
	{ id: 'p1', observed: false, position: 1, state: 'applied', canonical: true },
	{ id: 'p2', observed: false, position: 2, state: 'applied', canonical: true }
];

const dossier: Dossier = {
	subject: root,
	subjectType: 'product',
	retracted: false,
	title: { text: 'product v1', interpreted: false },
	snippet: undefined,
	identifiers: [],
	publisher: AUTHOR,
	createdAt: root.created_at,
	counts: { summary: 0, history: rows.length, files: 0 },
	content: { text: 'v1\n', banner: null },
	history: rows,
	files: []
};

describe('DetailDrawer history honesty (#165)', () => {
	afterEach(() => {
		shell.drawerSection = 'summary';
	});

	it('an unobserved reference renders its id and state word — no author, no epoch time', () => {
		shell.drawerSection = 'history';
		const { container } = render(DetailDrawerHarness, { props: { dossier } });

		const mounted = container.querySelectorAll('[data-history-row]');
		expect(mounted).toHaveLength(dossier.counts.history);
		expect(screen.getAllByText('referenced, not fetched')).toHaveLength(2);
		// The count chip is the rows rendered, not a separate tally.
		expect(screen.getByRole('button', { name: /History/ }).textContent).toContain(
			`· ${rows.length}`
		);

		// Unobserved rows carry no time element at all; only the root row does.
		expect(container.querySelectorAll('time')).toHaveLength(1);

		const text = container.textContent ?? '';
		expect(text).toContain('p1');
		expect(text).toContain('p2');
		expect(text).not.toContain('unknown'); // the old blank-author fallback
		expect(text).not.toContain('1970'); // the old zero-timestamp fallback
	});
});
