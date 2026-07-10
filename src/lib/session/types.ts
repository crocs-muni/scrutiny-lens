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
	type: 'product' | 'metadata' | 'patch' | 'deletion';
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
	lastSyncedAt: number;
	createdAt: number;
	updatedAt: number;
	chatHistory: ChatTurn[];
}
