import { browser } from '$app/environment';
import type { Session, NostrEvent } from '$lib/session/types.js';
import {
	db,
	deleteSession,
	getAllSessions,
	hydrateSession,
	saveSession
} from '$lib/session/db.js';
import { simpleGraphResolver, visibleSubgraph } from '$lib/session/resolver.js';
import { expandNodeNeighbors, fetchNodeNeighbors } from '$lib/session/fetcher.js';
import { connectRelay, disconnectRelay } from '$lib/search/relay.js';
import type { GraphView } from '$lib/session/types.js';

export type SessionStatus = 'idle' | 'loading' | 'syncing' | 'error';
// expandToHop can face a frontier hundreds of nodes wide (no capping on what
// a hop reveals) -- opening one relay connection per node overwhelms it, so
// hop expansion shares a single connection and processes in bounded batches.
const HOP_BATCH_SIZE = 20;

/**
 * BFS from root to targetId over the full (ungated) graph, returning the
 * intermediate ancestor ids in between -- not root, not targetId itself.
 * Manually expanding a deep node only protects that node's own id from a
 * later hop-collapse; without also protecting every node on the path down
 * to it, popping the hop level that contains its *parent* would still cut
 * the path and make it unreachable, even though its own id survived.
 */
function findAncestorChain(graph: GraphView, rootId: string, targetId: string): string[] {
	const parent = new Map<string, string>();
	const visited = new Set([rootId]);
	const queue = [rootId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current === targetId) break;
		for (const edge of graph.edges) {
			const other = edge.source === current ? edge.target : edge.target === current ? edge.source : null;
			if (other && !visited.has(other)) {
				visited.add(other);
				parent.set(other, current);
				queue.push(other);
			}
		}
	}

	const chain: string[] = [];
	let node = targetId;
	while (parent.has(node)) {
		node = parent.get(node)!;
		if (node === rootId) break;
		chain.push(node);
	}
	return chain;
}

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
		// events is typically a $state array from the caller (e.g. the search page) --
		// its reactive proxies aren't structured-cloneable, so IndexedDB's put() throws
		// a DataCloneError. Snapshot to plain data before it crosses into Dexie.
		const plainEvents = $state.snapshot(events);
		const now = Date.now();
		const session: Session = {
			id: crypto.randomUUID(),
			title,
			query,
			filters: [],
			interpretation: '',
			events: plainEvents,
			rootEventId: plainEvents[0]?.id ?? '',
			relatedEventIds: plainEvents.map((e) => e.id),
			expandedNodeIds: [],
			manuallyExpandedIds: [],
			hopLevels: [],
			hopDepth: 1,
			lastSyncedAt: now,
			createdAt: now,
			updatedAt: now,
			chatHistory: []
		};
		await saveSession(session);
		await this.loadList();
		return session;
	}

	/** The root is always implicitly expanded (the session's base view). */
	private computeGraph(session: Session): GraphView {
		const full = simpleGraphResolver(session.events);
		return visibleSubgraph(full, session.rootEventId, session.expandedNodeIds ?? []);
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

			this.graph = this.computeGraph(session);
			this.status = 'idle';
			return session;
		} catch (e) {
			this.status = 'error';
			this.error = e instanceof Error ? e.message : String(e);
			return null;
		}
	}

	async update(session: Session): Promise<void> {
		// session is often `this.active`, a reference into the reactive `sessions`
		// $state array -- writing through it (as toggleExpand does) keeps it a
		// live proxy, which throws the same DataCloneError create() hit earlier
		// when it reaches Dexie. Snapshot once here so every caller is covered.
		const plain = $state.snapshot(session);
		plain.updatedAt = Date.now();
		await saveSession(plain);
		await this.loadList();
		if (this.activeId === plain.id) {
			this.graph = this.computeGraph(plain);
		}
	}

	/**
	 * Reveals a node that's already in `session.events` (e.g. a chat citation
	 * target) without fetching anything -- unlike toggleExpand, the node's own
	 * neighbors aren't needed, only a path of expanded ancestors down to it so
	 * visibleSubgraph can reach it. Returns false if the id isn't part of this
	 * session's events at all (a stale/invalid citation).
	 */
	async revealNode(nodeId: string): Promise<boolean> {
		const session = this.active;
		if (!session) return false;
		if (!session.events.some((e) => e.id === nodeId)) return false;

		const expanded = new Set(session.expandedNodeIds ?? []);
		const manual = new Set(session.manuallyExpandedIds ?? []);
		const ancestorChain = findAncestorChain(simpleGraphResolver(session.events), session.rootEventId, nodeId);

		expanded.add(nodeId);
		manual.add(nodeId);
		for (const id of ancestorChain) {
			expanded.add(id);
			manual.add(id);
		}
		session.expandedNodeIds = Array.from(expanded);
		session.manuallyExpandedIds = Array.from(manual);
		await this.update(session);
		return true;
	}

	/**
	 * Toggles a node's expand state. Expanding fetches that node's immediate
	 * neighborhood on demand and merges it into the session's event cache;
	 * collapsing just removes it from expandedNodeIds -- visibleSubgraph
	 * recomputes what's reachable, so a node kept visible via another expanded
	 * parent doesn't disappear. Both persist to the session immediately.
	 *
	 * Also tracked in manuallyExpandedIds, separate from whatever the global
	 * hop control has done -- so collapsing a hop level later never yanks away
	 * a node the user deliberately opened by hand via its own "+" chip.
	 */
	async toggleExpand(nodeId: string): Promise<void> {
		const session = this.active;
		if (!session) return;
		const expanded = new Set(session.expandedNodeIds ?? []);
		const manual = new Set(session.manuallyExpandedIds ?? []);

		if (expanded.has(nodeId)) {
			expanded.delete(nodeId);
			manual.delete(nodeId);
			session.expandedNodeIds = Array.from(expanded);
			session.manuallyExpandedIds = Array.from(manual);
			await this.update(session);
			return;
		}

		try {
			// nodeId is only clickable because it's already reachable from root
			// through the currently-expanded set -- protect that whole path, not
			// just nodeId itself, or a later hop-collapse could cut an ancestor
			// out from under it and orphan it despite its own id being "safe".
			const ancestorChain = findAncestorChain(simpleGraphResolver(session.events), session.rootEventId, nodeId);

			const fresh = await expandNodeNeighbors(nodeId);
			const map = new Map(session.events.map((e) => [e.id, e]));
			for (const event of fresh) map.set(event.id, event);
			session.events = Array.from(map.values());
			expanded.add(nodeId);
			manual.add(nodeId);
			for (const id of ancestorChain) {
				expanded.add(id);
				manual.add(id);
			}
			session.expandedNodeIds = Array.from(expanded);
			session.manuallyExpandedIds = Array.from(manual);
			await this.update(session);
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	/**
	 * Bulk version of toggleExpand, in both directions.
	 *
	 * Increasing: expands every node reachable within `targetDepth` hops of
	 * the root, breadth-first, one hop at a time (root is always shown, so
	 * depth 1 is the base view, depth 2 expands the root's direct neighbors,
	 * depth 3 expands those neighbors' neighbors too, etc). Each hop's newly
	 * revealed ids are recorded as their own entry in hopLevels.
	 *
	 * Decreasing: pops hopLevels entries from the end down to the target
	 * depth and removes their ids from expandedNodeIds -- except any id also
	 * in manuallyExpandedIds, which toggleExpand's own "+" chip put there
	 * deliberately and this must never collapse. Nodes kept visible through a
	 * different still-expanded path aren't affected either way, since
	 * visibleSubgraph recomputes reachability from expandedNodeIds fresh.
	 */
	async expandToHop(targetDepth: number): Promise<void> {
		const session = this.active;
		if (!session || targetDepth < 1) return;
		const currentDepth = session.hopDepth ?? 1;
		if (targetDepth === currentDepth) return;

		const expanded = new Set(session.expandedNodeIds ?? []);
		const manual = new Set(session.manuallyExpandedIds ?? []);
		const hopLevels = (session.hopLevels ?? []).map((level) => [...level]);

		if (targetDepth < currentDepth) {
			while (hopLevels.length > targetDepth - 1) {
				const level = hopLevels.pop();
				if (!level) break;
				for (const id of level) {
					if (!manual.has(id)) expanded.delete(id);
				}
			}
			session.expandedNodeIds = Array.from(expanded);
			session.hopLevels = hopLevels;
			session.hopDepth = targetDepth;
			await this.update(session);
			return;
		}

		let events = session.events;
		const ndk = await connectRelay();
		if (!ndk) {
			this.error = 'Could not connect to the relay';
			return;
		}

		try {
			for (let hop = hopLevels.length; hop < targetDepth - 1; hop++) {
				const visible = visibleSubgraph(simpleGraphResolver(events), session.rootEventId, expanded);
				const frontier = visible.nodes
					.map((n) => n.id)
					.filter((id) => id !== session.rootEventId && !expanded.has(id));
				if (frontier.length === 0) break;

				const map = new Map(events.map((e) => [e.id, e]));
				for (let i = 0; i < frontier.length; i += HOP_BATCH_SIZE) {
					const batch = frontier.slice(i, i + HOP_BATCH_SIZE);
					const results = await Promise.all(batch.map((id) => fetchNodeNeighbors(ndk, id)));
					for (const fresh of results) for (const event of fresh) map.set(event.id, event);
				}
				events = Array.from(map.values());
				for (const id of frontier) expanded.add(id);
				hopLevels.push(frontier);
			}

			session.events = events;
			session.expandedNodeIds = Array.from(expanded);
			session.hopLevels = hopLevels;
			session.hopDepth = targetDepth;
			await this.update(session);
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			disconnectRelay(ndk);
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
