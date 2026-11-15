// Throwaway: same repro, but write the failure to a file (grep eats output).
import 'fake-indexeddb/auto';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsDialog from '../../src/lib/components/shell/SettingsDialog.svelte';
import { resetShell, shell } from '../../src/lib/shell.svelte';
import { resetSettings } from '../../src/lib/settings.svelte';
import { clearAllLocalData, initPersistence, _closeForTests } from '$lib/db';

beforeEach(async () => {
	await initPersistence();
	await clearAllLocalData();
	resetShell();
	resetSettings();
});

afterEach(async () => {
	await clearAllLocalData();
	await _closeForTests();
});

describe('settings dialog focus return (APG dialog-modal, WCAG 2.4.3)', () => {
	it('returns focus to the trigger after the dialog unmounts', async () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Settings';
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		shell.settingsOpen = true;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const dialog = mount(SettingsDialog, {
			target,
			props: { onClose: () => (shell.settingsOpen = false) }
		});

		await vi.waitFor(() => expect(document.activeElement).not.toBe(trigger));
		shell.settingsOpen = false;
		unmount(dialog, { outro: false });
		target.remove();

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(trigger);
		});
		trigger.remove();
	});
});
