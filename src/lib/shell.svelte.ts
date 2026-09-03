// Shell state (spec §9): three retractable columns + DetailDrawer + keyboard
// map. Runes state is the in-memory truth; session mutations additionally
// persist fire-and-forget via $lib/db (issue #12) and the layout hydrates
// the rail from the store at boot.

import { deleteSession, putSession } from '$lib/db';

/** One investigation in the flat sessions rail (spec §0 "Session"). */
export interface SessionRow {
	id: string;
	/** The question as asked; "Untitled session" until the user asks. */
	title: string;
	createdAt: number;
	/** Unseen-update dot (SidebarRecents anatomy, issue #10). */
	unseen?: boolean;
}

/** Center column stages (issue #10: swaps search → results → session).
 * `results` arrives with the query pipeline (spec §11 step 2). */
export type CenterView = 'search' | 'session';

class ShellState {
	railOpen = $state(true);
	/** Chat column is resident only while a session is open (spec §9). */
	chatOpen = $state(true);
	settingsOpen = $state(false);
	view = $state<CenterView>('search');
	session = $state<SessionRow | null>(null);
	sessions = $state<SessionRow[]>([]);
	drawerOpen = $state(true);
	drawerHeight = $state(320);

	toggleRail() {
		this.railOpen = !this.railOpen;
	}

	toggleChat() {
		if (!this.session) return; // chat exists only with an open session
		this.chatOpen = !this.chatOpen;
	}

	toggleDrawer() {
		if (!this.session) return;
		this.drawerOpen = !this.drawerOpen;
	}

	toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
	}

	/** Home = the search hero (owner ruling 2026-09-03): "New session" and
	 * the rail brand both land here; the session list is untouched, so the
	 * previous investigation keeps filling in the background. */
	home() {
		this.session = null;
		this.view = 'search';
	}

	newSession(title = 'Untitled session') {
		// issue #37: the investigation orchestrator is the only production
		// caller and always passes the question; the default title is the
		// test seam's convenience (the rail's New-session row now opens the
		// hero instead of minting an empty session).
		const row: SessionRow = {
			id: crypto.randomUUID(),
			title,
			createdAt: Date.now()
		};
		this.sessions.unshift(row);
		void putSession(row);
		this.activate(row);
	}

	private activate(row: SessionRow) {
		this.session = row;
		this.view = 'session';
		this.chatOpen = true;
	}

	openSession(id: string) {
		const row = this.sessions.find((s) => s.id === id);
		if (!row) return;
		row.unseen = false;
		void putSession(row);
		this.activate(row);
	}

	closeSession(id: string) {
		this.sessions = this.sessions.filter((s) => s.id !== id);
		void deleteSession(id);
		if (this.session?.id === id) {
			this.session = null;
			this.view = 'search';
		}
	}
}

export const shell = new ShellState();

/** Test hook — the singleton survives across spec files. */
export function resetShell() {
	shell.railOpen = true;
	shell.chatOpen = true;
	shell.settingsOpen = false;
	shell.view = 'search';
	shell.session = null;
	shell.sessions = [];
	shell.drawerOpen = true;
	shell.drawerHeight = 320;
}

/** Keyboard map (spec §9): Ctrl+\ rail · Ctrl+. chat · Ctrl+; drawer · Ctrl+, settings
 * (Ctrl+; replaces Ctrl+Shift+I — that combo opens devtools; owner ruling). Every binding is ignored while typing. Returns true when
 * the event was consumed. */
export function handleShellKeydown(event: KeyboardEvent): boolean {
	// Esc dismisses the settings surface without touching column state.
	if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) {
		if (!shell.settingsOpen) return false;
		// bits-ui's floating layers (the model combobox) preventDefault an
		// Escape they consume — then it must NOT also close the dialog.
		if (event.defaultPrevented) return false;
		event.preventDefault();
		// Commits are blur-triggered; unmounting keeps focus in place, so a
		// typed-but-unblurred field would drop its text. Blur first.
		(globalThis.document?.activeElement as HTMLElement | null)?.blur?.();
		shell.settingsOpen = false;
		return true;
	}
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
	const target = event.target as HTMLElement | null;
	if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return false;
	const key = event.key.toLowerCase();
	if (key === '\\' && !event.shiftKey) {
		shell.toggleRail();
	} else if (key === '.' && !event.shiftKey) {
		if (!shell.session) return false;
		shell.toggleChat();
	} else if (key === ';' && !event.shiftKey) {
		if (!shell.session) return false;
		shell.toggleDrawer();
	} else if (key === ',' && !event.shiftKey) {
		shell.toggleSettings();
	} else {
		return false;
	}
	event.preventDefault();
	return true;
}

/** Boot hydration merge (issue #12): the persisted list is the newest-first
 * base; live entries created before hydration finished (a pre-hydration
 * newSession whose put hasn't flushed) are kept — deduped by id, everything
 * sorted newest-first (round-2 review: layout sort was previously untested
 * UI code). */
export function mergeSessionLists(persisted: SessionRow[], live: SessionRow[]): SessionRow[] {
	const known = new Set(persisted.map((s) => s.id));
	return [...persisted, ...live.filter((s) => !known.has(s.id))].toSorted(
		(a, b) => b.createdAt - a.createdAt
	);
}

/** Relative time for rail rows — machine-made value, mono by the writing
 * rule (spec §9). Matches the design board's "2w ago" shape. */
export function formatRel(createdAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (seconds < 60) return 'now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const weeks = Math.floor(days / 7);
	if (weeks < 52) return `${weeks}w ago`;
	return `${Math.floor(weeks / 52)}y ago`;
}
