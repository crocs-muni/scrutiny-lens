// Contract test for Settings → Trusted publishers (spec §2 admission, ADR
// 0004): the curated list is the default view and is editable on this device
// only. Drives the real dialog against the real trust store; only the profile
// seam is mocked, because a settings dialog must not open relay sockets in
// jsdom (the name line is a separate, deterministic contract).

import 'fake-indexeddb/auto';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './SettingsDialogHarness.svelte';
import { clearAllLocalData, initPersistence, _closeForTests } from '$lib/db';
import { resetSettings } from '$lib/settings.svelte';
import { trust } from '$lib/trust-store.svelte';
import { publisherNpub } from '$lib/publisher';

const profileMock = vi.hoisted(() =>
	vi.fn(async (pubkey: string) => ({ name: `Name ${pubkey.slice(0, 4)}`, picture: null }))
);
vi.mock('$lib/net/profiles', () => ({ getProfile: profileMock }));

let teardown: (() => void) | null = null;
let target: HTMLElement | null = null;

/** Deterministic keys that cannot collide with the shipped corpus. */
const hexKey = (n: number): string => n.toString(16).padStart(64, '0');

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
	profileMock.mockClear();
	await trust.ready();
	await trust.reset();
	// reset() persists (and would show its note); start each test from the
	// honest blank footer so the note test proves the mapping.
	trust.persistState = 'idle';
});

afterEach(async () => {
	teardown?.();
	teardown = null;
	target?.remove();
	target = null;
	await clearAllLocalData();
	await _closeForTests();
});

function mountDialog(): void {
	target = document.createElement('div');
	document.body.appendChild(target);
	const app = mount(Harness, { target, props: { onClose: () => undefined } });
	teardown = () => void unmount(app, { outro: false });
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-trust-row]')];
const rowFor = (pubkey: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-trust-row][data-pubkey="${pubkey}"]`);
const nameLine = (pubkey: string): string =>
	rowFor(pubkey)?.querySelector('[data-trust-name]')?.textContent?.replace(/\s+/g, ' ').trim() ??
	'';
const errorText = (): string | null =>
	document.querySelector('[data-trust-error]')?.textContent?.trim() ?? null;
const noteText = (): string | null =>
	document.querySelector('[data-trust-note]')?.textContent?.trim() ?? null;
const resetButton = (): HTMLButtonElement | null =>
	[...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Reset to the project list'
	) ?? null;

function keyInput(): HTMLInputElement {
	const inputs = document.querySelectorAll<HTMLInputElement>('[data-trust-row] input');
	const input = inputs[inputs.length - 1];
	if (input === undefined) throw new Error('publisher key input not found');
	return input;
}

async function addPublisherRow(): Promise<void> {
	// Let the hydrate rebase land before appending; the new row is a dirty
	// edit, so the same effect cannot erase it.
	await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
	const button = [...document.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === 'Add publisher'
	);
	if (button === undefined) throw new Error('add publisher button not found');
	button.click();
	await vi.waitFor(() => expect(rows()[rows().length - 1]?.querySelector('input')).toBeTruthy());
}

function typeKey(value: string): void {
	const input = keyInput();
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(): void {
	keyInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

function clickRemove(pubkey: string): void {
	rowFor(pubkey)?.querySelector<HTMLButtonElement>('button[aria-label="Remove publisher"]')?.click();
}

describe('settings trusted publishers (spec §2 admission, ADR 0004)', () => {
	it('renders the empty list when every bundled publisher is removed', async () => {
		for (const publisher of [...trust.publishers]) await trust.remove(publisher.pubkey);
		mountDialog();

		await vi.waitFor(() => expect(rows()).toHaveLength(0));
		const list = document.querySelector('[data-trust-list]');
		expect(list?.className).toContain('max-h-[200px]');
		expect(list?.className).toContain('overflow-y-auto');
		expect(list?.textContent).toContain('No publishers trusted.');
	});

	it('renders a scrollable list of 30 rows', async () => {
		let n = 1;
		while (trust.publishers.length < 30) await trust.add(hexKey(n++));
		mountDialog();

		await vi.waitFor(() => expect(rows()).toHaveLength(30));
	});

	it('adds a publisher through a new row and commits it', async () => {
		mountDialog();
		expect(resetButton()).toBeNull();
		const key = hexKey(0xabc);
		await addPublisherRow();
		typeKey(key);
		pressEnter();

		await vi.waitFor(() => expect(trust.isTrusted(key)).toBe(true));
		await vi.waitFor(() => expect(rowFor(key)).not.toBeNull());
		await vi.waitFor(() => expect(keyInput().value).toBe(publisherNpub(key)));
		await vi.waitFor(() => expect(nameLine(key)).toContain('Name '));
		expect(errorText()).toBeNull();
	});

	it('shows the kind-0 name above the input and refreshes it on focus', async () => {
		const publisher = trust.publishers[0]!;
		mountDialog();
		await vi.waitFor(() => expect(nameLine(publisher.pubkey)).toContain('Name '));

		const input = rowFor(publisher.pubkey)?.querySelector('input');
		input?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		await vi.waitFor(() =>
			expect(profileMock).toHaveBeenCalledWith(publisher.pubkey, { refresh: true })
		);
	});

	it('shows the store message for an invalid key and adds nothing', async () => {
		const returned = await trust.add('definitely not a key');
		if (returned.ok) throw new Error('expected the store to reject the input');
		const before = trust.publishers.length;
		mountDialog();
		await addPublisherRow();
		typeKey('definitely not a key');
		pressEnter();

		await vi.waitFor(() => expect(errorText()).toBe(returned.message));
		expect(trust.publishers).toHaveLength(before);
	});

	it('dedupes a duplicate on commit instead of adding a second row', async () => {
		const key = trust.publishers[0]!.pubkey;
		mountDialog();
		await addPublisherRow();
		typeKey(publisherNpub(key));
		pressEnter();

		await vi.waitFor(() => expect(errorText()).toBeNull());
		await vi.waitFor(() =>
			expect(rows().filter((row) => row.dataset.pubkey === key)).toHaveLength(1)
		);
	});

	it('removes a publisher from its row', async () => {
		const key = hexKey(0x123);
		await trust.add(key);
		mountDialog();
		await vi.waitFor(() => expect(rowFor(key)).not.toBeNull());

		clickRemove(key);
		await vi.waitFor(() => expect(trust.isTrusted(key)).toBe(false));
		expect(rowFor(key)).toBeNull();
	});

	it('removes a bundled publisher and restores the project list with reset', async () => {
		const bundled = [...trust.publishers][0];
		if (bundled === undefined) throw new Error('nothing bundled to remove');
		await trust.add(hexKey(0x456));
		mountDialog();
		await vi.waitFor(() => expect(rowFor(bundled.pubkey)).not.toBeNull());

		clickRemove(bundled.pubkey);
		await vi.waitFor(() => expect(trust.isTrusted(bundled.pubkey)).toBe(false));
		expect(trust.overrides.removed).toContain(bundled.pubkey);
		await vi.waitFor(() => expect(resetButton()).not.toBeNull());

		resetButton()?.click();
		await vi.waitFor(() => {
			expect(trust.overrides.added).toHaveLength(0);
			expect(trust.overrides.removed).toHaveLength(0);
		});
		await vi.waitFor(() => expect(rowFor(bundled.pubkey)).not.toBeNull());
		await vi.waitFor(() => expect(resetButton()).toBeNull());
	});

	it('shows the save truth of the trust list after a change', async () => {
		mountDialog();
		expect(noteText()).toBeNull();

		await addPublisherRow();
		typeKey(hexKey(0x789));
		pressEnter();
		await vi.waitFor(() => expect(trust.persistState).toBe('saved'));
		await vi.waitFor(() => expect(noteText()).toBe('saved on this device'));
	});
});
