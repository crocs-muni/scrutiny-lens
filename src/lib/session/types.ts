import type { ChatTurn } from '$lib/ai/types.js';

export interface NostrEvent {
	id: string;
	sig: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	label: string;
}

export interface GraphNode {
	id: string;
	type: 'product' | 'metadata';
	retracted: boolean;
	event: NostrEvent;
}

export interface GraphView {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export type GraphResolver = (events: NostrEvent[]) => GraphView;

export interface Session {
	id: string;
	title: string;
	query: string;
	filters: Record<string, unknown>[];
	interpretation: string;
	events: NostrEvent[];
	rootEventId: string;
	relatedEventIds: string[];
	/** Non-root node ids the user has expanded to reveal their own neighbors. */
	expandedNodeIds: string[];
	/** Ids expanded one at a time via a node's own "+" chip -- protected from
	 *  being collapsed back by the global hop control, since the user opened
	 *  them deliberately, independent of whatever hop depth is set. */
	manuallyExpandedIds: string[];
	/** Ids the global hop control expanded, grouped by the hop step that
	 *  revealed them (hopLevels[0] = expanding hop 1 -> 2, etc). Lets the hop
	 *  control collapse exactly what it revealed without touching anything
	 *  reached a different way. Invariant: hopDepth === hopLevels.length + 1. */
	hopLevels: string[][];
	/** Current depth the global hop control has expanded to (1 = base view). */
	hopDepth: number;
	lastSyncedAt: number;
	createdAt: number;
	updatedAt: number;
	chatHistory: ChatTurn[];
}
