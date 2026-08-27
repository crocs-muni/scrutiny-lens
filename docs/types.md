# SCRUTINY Lens — Shared Types

> Status: **Draft** · Cross-references: [view-models.md](view-models.md) · [api.md](api.md)
> Canonical types referenced across docs. These are the ONLY shared-type definitions; docs never redefine them.

---

## Indexer prefixes

```ts
/** Indexer prefixes the query agent MAY emit and the UI recognizes (validated at the agent boundary — J1 AC7). */
export const KNOWN_INDEXER_PREFIXES = new Set(['cc', 'cve', 'cpe', 'cwe', 'vendor', 'pp'] as const);
```

## Wire types

```ts
/** Nostr event as it comes off the relay (nostr-tools surface). */
export interface NostrEvent {
  id: string;
  sig: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** Query agent output filter — business-level; transport applies relay defaults (kinds:[1], limit:50). */
export type SearchMode = 'browse' | 'identifier' | 'freetext';
export interface SearchFilter {
  mode: SearchMode;
  identifier?: string;
  search?: string;
  types?: string[];
}
```

## Graph types (resolver output — deterministic; replaces v1 hand-rolled resolver semantics with core resolve/admit)

```ts
export interface GraphNode {
  id: string;                      // event id
  type: 'product' | 'metadata';    // protocol entity classification (bindings are edges)
  retracted: boolean;              // target of a kind-5 deletion
  event: NostrEvent;
}

export interface GraphEdge {
  id: string;
  source: string;                  // metadata node id
  target: string;                  // product node id (arrow points Metadata → Product)
  label: string;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphResolver = (events: NostrEvent[]) => GraphView;
```

## Session types

```ts
/** Persisted conversation turn. Wire shape used by /api/chat history. NOT the same as ChatMessageVM — the VM is the
 *  rendered assistant answer (with citations/followUps) rebuilt at load from events + registry; ChatTurn is compact. */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

export interface Session {
  id: string;
  title: string;                          // from query (first 50 chars)
  query: string;
  filters: Record<string, unknown>[];
  interpretation: string;
  events: NostrEvent[];
  rootEventId: string;
  relatedEventIds: string[];
  expandedNodeIds: string[];              // nodes whose neighbors the user revealed (J2 "+")
  manuallyExpandedIds: string[];          // protected from hop-collapse (user opened deliberately)
  hopLevels: string[][];                  // hopLevels[i] = ids revealed at hop step i+1
  hopDepth: number;                       // current global depth (1 = base view)
  lastSyncedAt: number;                   // SessionListItemVM.updateCount derives from this
  createdAt: number;
  updatedAt: number;
  chatHistory: ChatTurn[];
}
```

Note: viewport zoom/pan is device-local (XYFlow state), NOT persisted. J5 restores graph expansion + chat only.

## Citation (canonical — reused by component-registry.md)

```ts
export interface Citation {
  n: number;              // stable per-conversation
  eventId: string;
  quote: string;
  verified: boolean;
  nodeTitle?: string;
}
```

## Registry aliases

```ts
/** Lookup keys into ComponentRegistry (component-registry.md §1). Keys are registry-owned; see that file's contract. */
export type VMKind =
  | 'card' | 'interpreting' | 'facets' | 'result.group'
  | 'node.product' | 'node.vulnerability' | 'node.metadata' | 'node.unknown' | 'node.detail'
  | 'chat.message' | 'state.empty' | 'state.relay-error' | 'state.ungrounded' | 'session.item';

/** vm.kind → content type mapping (see component-registry.md §1 for component shapes). */
export interface VMMap { card: CardVM; /* … one entry per VMKind, mirrors view-models.md §3 */ }
```
