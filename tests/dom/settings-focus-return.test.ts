// Red repro (WCAG 2.4.3 / APG dialog-modal): focus must return to the
// Settings trigger when the dialog closes. Today the dialog's cleanup
// calls focus() on the trigger while the dialog is still mounted — and
// +page.svelte keeps the app [inert] while it is, so an inert element
// cannot receive focus and focus falls to <body>.
//
// Drives the real component through the real close path (the harness's
// {#if} unmount, the same thing shell.settingsOpen=false does in
// +page.svelte).

import 'fake-indexeddb/auto';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './SettingsDialogHarness.svelte';
import { resetSettings } from '../../src/lib/settings.svelte';
import { clearAllLocalData, initPersistence, _closeForTests } from '$lib/db';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
});

afterEach(async () => {
	await clearAllLocalData();
	await _closeForTests();
});

describe('settings dialog focus return (APG dialog-modal, WCAG 2.4.3)', () => {
	it('returns focus to the trigger after the dialog closes', async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		let closed = false;
		const app = mount(Harness, { target, props: { onClose: () => (closed = true) } });

		const trigger = document.getElementById('settings-trigger') as HTMLButtonElement;
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		// Opening the dialog moves focus into it (the endpoint field).
		await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));
		expect(document.activeElement).not.toBe(trigger);

		// Close through the dialog's close button — the same closeDialog()
		// path the shell's Esc map reaches (blur, then onClose).
		//
		// In the real app (+page.svelte) the trigger's container is
		// [inert] while the dialog is open and the cleanup races the
		// unmount: in Chromium the focus() call lands while the attribute
		// is still on the ancestor, so it silently fails. jsdom does not
		// implement that blocking, so the harness also asserts the
		// attribute is GONE before the focus claim is trusted.
		const closeButton = document.querySelector<HTMLButtonElement>('button[aria-label*="lose" i]');
		if (closeButton === null) throw new Error('close button not found');
		closeButton.click();
		await vi.waitFor(() => expect(closed).toBe(true));
		await vi.waitFor(() => {
			expect(trigger.closest('[inert]')).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});

		unmount(app, { outro: false });
		target.remove();
	});
});
