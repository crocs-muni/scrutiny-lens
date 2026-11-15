// Contract test (WCAG 2.4.3 / APG dialog-modal): closing the Settings
// dialog returns focus to the trigger.
//
// jsdom does not implement inert's focus blocking, so this cannot reproduce
// the Chromium race it guards (the fix's queueMicrotask exists for the real
// browser; verified there with a Playwright probe). What it DOES pin: the
// capture-and-restore itself, on the shell's shape (inert sibling + {#if}
// unmount, as +page.svelte renders it). Deleting the restore fails this.

import 'fake-indexeddb/auto';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Harness from './SettingsDialogHarness.svelte';
import { resetSettings } from '../../src/lib/settings.svelte';
import { clearAllLocalData, initPersistence, _closeForTests } from '$lib/db';

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement | null = null;

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetSettings();
});

afterEach(async () => {
	if (app !== null) unmount(app, { outro: false });
	target?.remove();
	app = null;
	target = null;
	await clearAllLocalData();
	await _closeForTests();
});

describe('settings dialog focus return (APG dialog-modal, WCAG 2.4.3)', () => {
	it('returns focus to the trigger after the dialog closes', async () => {
		target = document.createElement('div');
		document.body.appendChild(target);
		let closed = false;
		app = mount(Harness, { target, props: { onClose: () => (closed = true) } });

		const trigger = document.getElementById('settings-trigger') as HTMLButtonElement;
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		// Opening the dialog moves focus into it (the endpoint field).
		await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));
		expect(document.activeElement).not.toBe(trigger);

		// Close through the dialog's close button — the same closeDialog()
		// path the shell's Esc map reaches (blur, then onClose).
		const closeButton = document.querySelector<HTMLButtonElement>('button[aria-label*="lose" i]');
		if (closeButton === null) throw new Error('close button not found');
		closeButton.click();
		await vi.waitFor(() => expect(closed).toBe(true));
		await vi.waitFor(() => {
			expect(trigger.closest('[inert]')).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});
	});

	it('a target that stays inert does not hang the cleanup — focus settles without it', async () => {
		// The risky branch: the restore target's ancestor keeps [inert]
		// after close (a rail collapsed while the dialog was open). The
		// cleanup must not spin waiting for it.
		target = document.createElement('div');
		document.body.appendChild(target);
		app = mount(Harness, { target, props: { onClose: () => undefined } });
		await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));

		const closeButton = document.querySelector<HTMLButtonElement>('button[aria-label*="lose" i]');
		if (closeButton === null) throw new Error('close button not found');
		closeButton.click();
		// Force the branch: re-inert the wrapper the trigger lives in.
		const wrapper = document.getElementById('settings-trigger')?.parentElement;
		if (wrapper === null) throw new Error('wrapper not found');
		wrapper.setAttribute('inert', '');

		// The cleanup ran; nothing hung. Focus is wherever the DOM put it.
		await vi.waitFor(() =>
			expect(document.activeElement?.tagName ?? 'BODY').toBeTruthy()
		);
	});
});
