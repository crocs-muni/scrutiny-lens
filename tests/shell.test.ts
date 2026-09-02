// Shell contract (issue #10, spec §9): keyboard map, session gating for the
// chat column and detail drawer, rail session lifecycle, relative-time shape.

import { beforeEach, describe, expect, it } from 'vitest';
import { formatRel, handleShellKeydown, mergeSessionLists, resetShell, shell, type SessionRow } from '../src/lib/shell.svelte';

function key(
	init: { key: string; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean },
	target: unknown = null
): KeyboardEvent {
	let prevented = false;
	return {
		key: init.key,
		ctrlKey: init.ctrl ?? false,
		metaKey: init.meta ?? false,
		shiftKey: init.shift ?? false,
		altKey: init.alt ?? false,
		target,
		preventDefault() {
			prevented = true;
		},
		get defaultPrevented() {
			return prevented;
		}
	} as unknown as KeyboardEvent;
}

/** A target inside a text field — hotkeys must not fire while typing. */
const typingTarget = { closest: () => ({}) };
const nonTypingTarget = { closest: () => null };

beforeEach(() => resetShell());

describe('keyboard map', () => {
	it('Ctrl+\\ toggles the sessions rail independently', () => {
		expect(handleShellKeydown(key({ key: '\\', ctrl: true }, nonTypingTarget))).toBe(true);
		expect(shell.railOpen).toBe(false);
		handleShellKeydown(key({ key: '\\', ctrl: true }, nonTypingTarget));
		expect(shell.railOpen).toBe(true);
	});

	it('Ctrl+, toggles settings and Esc dismisses it', () => {
		handleShellKeydown(key({ key: ',', ctrl: true }, nonTypingTarget));
		expect(shell.settingsOpen).toBe(true);
		expect(handleShellKeydown(key({ key: 'Escape' }, nonTypingTarget))).toBe(true);
		expect(shell.settingsOpen).toBe(false);
	});

	it('Esc already consumed by a floating layer does not also close settings', () => {
		// bits-ui layers (e.g. the model combobox) preventDefault a consumed
		// Escape — the shell must not treat it as a dialog dismiss too.
		handleShellKeydown(key({ key: ',', ctrl: true }, nonTypingTarget));
		const event = key({ key: 'Escape' }, nonTypingTarget);
		event.preventDefault();
		expect(handleShellKeydown(event)).toBe(false);
		expect(shell.settingsOpen).toBe(true);
	});

	it('Ctrl+. and Ctrl+; are inert until a session is open', () => {
		expect(handleShellKeydown(key({ key: '.', ctrl: true }, nonTypingTarget))).toBe(false);
		expect(handleShellKeydown(key({ key: ';', ctrl: true }, nonTypingTarget))).toBe(false);
		expect(shell.chatOpen).toBe(true);
		expect(shell.drawerOpen).toBe(true);
	});

	it('Ctrl+. toggles chat once a session is open', () => {
		shell.newSession();
		handleShellKeydown(key({ key: '.', ctrl: true }, nonTypingTarget));
		expect(shell.chatOpen).toBe(false);
		handleShellKeydown(key({ key: '.', ctrl: true }, nonTypingTarget));
		expect(shell.chatOpen).toBe(true);
	});

	it('Ctrl+; toggles the DetailDrawer once a session is open', () => {
		shell.newSession();
		handleShellKeydown(key({ key: ';', ctrl: true }, nonTypingTarget));
		expect(shell.drawerOpen).toBe(false);
	});

	it('ignores the map while typing in a field', () => {
		shell.newSession();
		expect(handleShellKeydown(key({ key: '\\', ctrl: true }, typingTarget))).toBe(false);
		expect(shell.railOpen).toBe(true);
	});

	it('ignores bare keys and alt-modified keys', () => {
		expect(handleShellKeydown(key({ key: '\\' }, nonTypingTarget))).toBe(false);
		expect(
			handleShellKeydown(key({ key: '\\', ctrl: true, alt: true }, nonTypingTarget))
		).toBe(false);
		expect(shell.railOpen).toBe(true);
	});
});

describe('session lifecycle', () => {
	it('New session opens the session view with chat visible', () => {
		shell.newSession();
		expect(shell.view).toBe('session');
		expect(shell.session?.title).toBe('Untitled session');
		expect(shell.chatOpen).toBe(true);
		expect(shell.sessions).toHaveLength(1);
	});

	it('picking a row marks it seen and reopens chat', () => {
		shell.newSession();
		const id = shell.session!.id;
		shell.closeSession(id); // back to search view
		shell.sessions.unshift({ id, title: 'ROCA in Infineon chips', createdAt: Date.now(), unseen: true });
		shell.openSession(id);
		expect(shell.view).toBe('session');
		expect(shell.sessions[0].unseen).toBe(false);
		expect(handleShellKeydown(key({ key: '.', ctrl: true }, nonTypingTarget))).toBe(true); // chat toggles again
		expect(shell.chatOpen).toBe(false);
	});

	it('closing the active session returns to search view (chat unmounts)', () => {
		shell.newSession();
		shell.closeSession(shell.session!.id);
		expect(shell.view).toBe('search');
		expect(shell.session).toBeNull();
		expect(shell.sessions).toHaveLength(0);
	});
});

describe('formatRel', () => {
	const now = Date.parse('2026-08-31T12:00:00Z');
	it.each([
		[30_000, 'now'],
		[5 * 60_000, '5m ago'],
		[2 * 3_600_000, '2h ago'],
		[3 * 86_400_000, '3d ago'],
		[14 * 86_400_000, '2w ago'],
		[400 * 86_400_000, '1y ago']
	])('maps %ims → %s', (delta, expected) => {
		expect(formatRel(now - delta, now)).toBe(expected);
	});
});

describe('mergeSessionLists (boot hydration, issue #12)', () => {
	const row = (id: string, createdAt: number): SessionRow => ({ id, title: id, createdAt });

	it('keeps pre-hydration live sessions, dedupes by id, sorts newest-first', () => {
		const persisted = [row('persisted-new', 300), row('persisted-old', 100)];
		const live = [row('boot-created', 200), row('persisted-old', 100)];
		expect(mergeSessionLists(persisted, live).map((s) => s.id)).toEqual([
			'persisted-new',
			'boot-created',
			'persisted-old'
		]);
	});
});
