/**
 * SCRUTINY Lens v2 — fabric protocol seam (wave W2).
 *
 * Client-side fabric seam. Core is sans-IO and crypto-free by design
 * (its README/D12): SHA-256 must be injected, and it never verifies schnorr
 * signatures — full SIG-1 (schnorr verify via @noble/curves + id recompute)
 * lands with the store integration (spec §8); this seam currently adds the
 * NIP-01 id recompute (tamper detection) plus protocol validation.
 *
 * ── W2 verification: actual @scrutiny-fabric/core 0.1.0 API surface ──────────
 * Verified against packages/core/etc/api-report.api.md (spec v0.8.1):
 *
 * - `validateEvent(event, { lookupEvent? })` → Validity with FOUR statuses:
 *   'valid' | 'invalid' | 'pending' | 'not-scrutiny'. 'not-scrutiny' (TAG-1) is
 *   out-of-scope, NOT the same as 'invalid'. 'pending' means the verdict awaits
 *   referenced events (`awaiting: string[]`) — bindings need their root/link
 *   endpoints in `lookupEvent` to settle (BD-rules). Issues carry `code`
 *   (RuleId, e.g. TAG-2), `severity`, `section`, `message` — we surface them
 *   verbatim, never catch-and-hide core's reasoning.
 *
 * - Hash injection (D12): `Sha256Hex = (serialized: string) => string` — the
 *   canonical NIP-01 serialization in, lowercase hex out; UTF-8 encoding is the
 *   caller's job. Injection points: `computeEventId` / `eventIdMatches` (id.js).
 *   `validateEvent` itself takes NO hash — id recompute is a separate gate.
 *
 * - `scrutinyEventType(event)` → 'product' | 'metadata' | 'binding' | 'patch' |
 *   undefined — the t-tag classification. Products and metadata are GRAPH
 *   NODES; bindings are EDGES (never nodes); patches belong to chain
 *   resolution (core `resolve()`), out of scope for GraphView construction.
 *
 * - `bindingEndpoints(binding)` → { rootId, linkId } — from e-tags marked
 *   'root' (the product) and 'link' (the metadata). GraphEdge arrows point
 *   Metadata → Product, so source = linkId, target = rootId; the binding's
 *   content is the human label ("PP conformance edge.").
 *
 * - `isDefaultViewRetracted(event, deletions)` — honoured NIP-09 (kind-5)
 *   deletions ONLY: same-pubkey authorship AND an e-tag targeting the event.
 *   Deletion markers never surface as display nodes; they set `retracted`.
 *
 * - Type mismatch: core's `NostrEvent` is deeply readonly; docs/types.md's is
 *   the mutable wire shape nostr-tools delivers. One cast at the boundary
 *   (`(… as CoreNostrEvent)`) instead of threading readonly through the app.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import {
	DELETION_KIND,
	bindingEndpoints,
	eventIdMatches,
	isDefaultViewRetracted,
	scrutinyEventType,
	validateEvent,
	type NostrEvent as CoreNostrEvent,
	type ScrutinyEventType,
	type Sha256Hex,
	type Validity
} from '@scrutiny-fabric/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { tTags, indexerFilter, searchFilter, fullScanFilter } from '@scrutiny-fabric/core';

/** Every value of the `t` tag on the event — core's derivation, never
 * hand-rolled, per AGENTS.md's "all protocol work via @scrutiny-fabric/core". */
export { tTags };

/** Relay filter builders (§8.1 of the protocol spec): exact i-tag, NIP-50
 * freetext fallback, and last-resort full scan. Re-exported here so the
 * pipeline (issue #28) never hand-rolls a filter. */
export { indexerFilter, searchFilter, fullScanFilter };

/** tagValues(event, key) — every value slot of every tag with that key. The
 * pipeline's skeleton sources index i-tags with it (never hand-rolled). */
export { tagValues } from '@scrutiny-fabric/core';

/* ── Shared types: docs/types.md is the canon; re-stated here so the seam is
 * self-contained and callers import one place. ──────────────────────────────*/

export interface NostrEvent {
	id: string;
	sig: string;
	pubkey: string;
	created_at: number;
	kind: number;
	tags: string[][];
	content: string;
}

export interface GraphNode {
	id: string;
	type: 'product' | 'metadata';
	retracted: boolean;
	event: NostrEvent;
}

export interface GraphEdge {
	id: string;
	source: string; // metadata node id
	target: string; // product node id (arrow: Metadata → Product)
	label: string;
}

export interface GraphView {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** The injected hash function core requires (D12). UTF-8 → SHA-256 → hex. */
export const sha256Hex: Sha256Hex = (serialized) =>
	bytesToHex(sha256(utf8ToBytes(serialized)));

/* ── Own boundary validation (zod): structural shape only. Protocol reasoning
 * stays with core — this layer adds no protocol judgment of its own. ────────*/

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

const nostrEventSchema = z.object({
	id: z.string().regex(HEX_64, 'id must be 64 lowercase hex chars'),
	pubkey: z.string().regex(HEX_64, 'pubkey must be 64 lowercase hex chars'),
	sig: z.string().regex(HEX_128, 'sig must be 128 lowercase hex chars'),
	created_at: z.number().int().nonnegative(),
	kind: z.number().int().nonnegative(),
	tags: z.array(z.array(z.string())),
	content: z.string()
});

function structuralError(event: NostrEvent): string | undefined {
	const parsed = nostrEventSchema.safeParse(event);
	if (parsed.success) return undefined;
	return `malformed event: ${parsed.error.issues
		.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
		.join('; ')}`;
}

/** docs/types.md shape cast once to core's deeply-readonly wire type. */
function asCore(event: NostrEvent): CoreNostrEvent {
	return event as unknown as CoreNostrEvent;
}

function reasonFor(verdict: Exclude<Validity, { status: 'valid' }>): string {
	switch (verdict.status) {
		case 'not-scrutiny':
			return 'not a SCRUTINY fabric event (missing fabric tag; TAG-1)';
		case 'pending':
			return `validity unresolved, awaiting referenced events: ${verdict.awaiting.join(', ')}`;
		case 'invalid':
			return verdict.issues.map((i) => `${i.code}: ${i.message}`).join('; ');
	}
}

export interface Classification {
	valid: NostrEvent[];
	invalid: { event: NostrEvent; reason: string }[];
}

/**
 * Protocol-level partition of a batch. Events reference only what they can see:
 * `lookupEvent` is backed by the batch itself, so bindings whose endpoints are
 * absent come back 'pending' (named ids in the reason) rather than 'invalid'.
 */
export function validateAndClassify(events: NostrEvent[]): Classification {
	const batch = new Map(events.map((event) => [event.id, event]));
	const lookupEvent = (id: string): CoreNostrEvent | undefined => {
		const found = batch.get(id);
		return found ? asCore(found) : undefined;
	};
	const valid: NostrEvent[] = [];
	const invalid: { event: NostrEvent; reason: string }[] = [];
	for (const event of events) {
		const structural = structuralError(event);
		if (structural !== undefined) {
			invalid.push({ event, reason: structural });
			continue;
		}
		const verdict = validateEvent(asCore(event), { lookupEvent });
		if (verdict.status === 'valid') valid.push(event);
		else
			invalid.push({
				event,
				reason: reasonFor(verdict)
			});
	}
	return { valid, invalid };
}

export type AdmitResult =
	| { ok: true; type: ScrutinyEventType }
	| { ok: false; reason: string };

/**
 * Strict single-event gate for events about to enter the graph: NIP-01 id
 * recompute via the injected hash (tampers and fabricated ids rejected), then
 * full core validation. 'pending' is not admissible on its own — the caller
 * must supply the referenced events and go through `validateAndClassify`.
 */
export function admitEvent(event: NostrEvent): AdmitResult {
	const structural = structuralError(event);
	if (structural !== undefined) return { ok: false, reason: structural };
	if (!eventIdMatches(asCore(event), sha256Hex)) {
		return {
			ok: false,
			reason:
				'event id does not match its NIP-01 recompute (contents tampered or id fabricated)'
		};
	}
	const verdict = validateEvent(asCore(event));
	if (verdict.status === 'valid') return { ok: true, type: verdict.type };
	return {
		ok: false,
		reason: reasonFor(verdict)
	};
}

/**
 * Map a batch of fabric events to the docs/types.md GraphView. Products and
 * metadata become nodes; bindings become Metadata → Product edges carrying the
 * binding content as label; honoured kind-5 deletions set `retracted` and never
 * appear as nodes. Edges whose endpoints are not both in the batch are dropped
 * (they would point at nodes the view does not contain).
 */
export function resolveGraph(events: NostrEvent[]): GraphView {
	const { valid } = validateAndClassify(events);
	const deletions: CoreNostrEvent[] = [];
	for (const event of events) {
		if (event.kind === DELETION_KIND && structuralError(event) === undefined) {
			deletions.push(asCore(event));
		}
	}

	const nodes: GraphNode[] = [];
	const nodeIds = new Set<string>();
	for (const event of valid) {
		const type = scrutinyEventType(asCore(event));
		if (type !== 'product' && type !== 'metadata') continue;
		nodeIds.add(event.id);
		nodes.push({
			id: event.id,
			type,
			retracted: isDefaultViewRetracted(asCore(event), deletions),
			event
		});
	}

	const edges: GraphEdge[] = [];
	for (const event of valid) {
		if (scrutinyEventType(asCore(event)) !== 'binding') continue;
		const endpoints = bindingEndpoints(asCore(event));
		if (!endpoints) continue;
		if (!nodeIds.has(endpoints.rootId) || !nodeIds.has(endpoints.linkId)) continue;
		edges.push({
			id: event.id,
			source: endpoints.linkId,
			target: endpoints.rootId,
			label: event.content
		});
	}

	return { nodes, edges };
}
