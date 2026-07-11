import { browser } from '$app/environment';
import type { Session, NostrEvent } from '$lib/session/types.js';
import {
	db,
	deleteSession,
	getAllSessions,
	hydrateSession,
	saveSession
} from '$lib/session/db.js';
import { simpleGraphResolver } from '$lib/session/resolver.js';
import type { GraphView } from '$lib/session/types.js';

export type SessionStatus = 'idle' | 'loading' | 'syncing' | 'error';

class SessionStore {
	// Reactive state
	sessions = $state<Session[]>([]);
	activeId = $state<string | null>(null);
	status = $state<SessionStatus>('idle');
	error = $state<string | null>(null);
	graph = $state<GraphView>({ nodes: [], edges: [] });

	constructor() {
		if (browser) {
			this.loadList();
		}
	}

	async loadList(): Promise<void> {
		if (!browser) return;
		this.status = 'loading';
		try {
			const records = await getAllSessions();
			const hydrated = await Promise.all(records.map((r) => hydrateSession(r.id)));
			this.sessions = hydrated.filter(Boolean) as Session[];
			this.status = 'idle';
		} catch (e) {
			this.status = 'error';
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	async create(title: string, query: string, events: NostrEvent[]): Promise<Session> {
		const now = Date.now();
		const session: Session = {
			id: crypto.randomUUID(),
			title,
			query,
			filters: [],
			interpretation: '',
			events,
			rootEventId: events[0]?.id ?? '',
			relatedEventIds: events.map((e) => e.id),
			lastSyncedAt: now,
			createdAt: now,
			updatedAt: now,
			chatHistory: []
		};
		await saveSession(session);
		await this.loadList();
		return session;
	}

	async open(
		id: string,
		fetcher?: (session: Session) => Promise<NostrEvent[]>
	): Promise<Session | null> {
		if (!browser) return null;
		this.activeId = id;
		this.status = 'loading';
		this.error = null;
		try {
			let session = await hydrateSession(id);
			if (!session) {
				this.status = 'error';
				this.error = 'Session not found';
				return null;
			}

			// Update-on-return: re-fetch and merge if a fetcher is provided.
			if (fetcher) {
				this.status = 'syncing';
				const fresh = await fetcher(session);
				const map = new Map(fresh.map((e) => [e.id, e]));
				for (const event of session.events) {
					if (!map.has(event.id)) map.set(event.id, event);
				}
				session = {
					...session,
					events: Array.from(map.values()).sort((a, b) => a.created_at - b.created_at),
					lastSyncedAt: Date.now(),
					updatedAt: Date.now()
				};
				await saveSession(session);
				await this.loadList();
			}

			this.graph = simpleGraphResolver(session.events);
			this.status = 'idle';
			return session;
		} catch (e) {
			this.status = 'error';
			this.error = e instanceof Error ? e.message : String(e);
			return null;
		}
	}

	async update(session: Session): Promise<void> {
		session.updatedAt = Date.now();
		await saveSession(session);
		await this.loadList();
		if (this.activeId === session.id) {
			this.graph = simpleGraphResolver(session.events);
		}
	}

	async remove(id: string): Promise<void> {
		await deleteSession(id);
		if (this.activeId === id) this.activeId = null;
		await this.loadList();
	}

	get active(): Session | undefined {
		return this.sessions.find((s) => s.id === this.activeId);
	}
}

export const sessionStore = new SessionStore();
