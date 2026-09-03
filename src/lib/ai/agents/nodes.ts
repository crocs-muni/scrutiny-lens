/**
 * W5 · Node agent — batched node interpretation (visible events → NodeVM[]).
 *
 * Pipeline (same batch pattern as the cards agent):
 *   1. Deterministic backbone per event: kind dispatch from the fabric
 *      (`resolveGraph` — validateAndClassify groupings; `retracted` carried
 *      from the resolver), status from tags, identifiers from known tag keys,
 *      bindings / updates from the resolver's edges.
 *   2. LLM drafts a plain-text JSON array per page of BATCH_SIZE events
 *      (one object per event, in order — no responseFormat; one repair-retry
 *      inside generateStructured).
 *   3. Per-kind zod gate (Product/Vulnerability/Metadata/UnknownNodeVM). The
 *      UnknownNodeVM summary is quote-verified against event content via the
 *      extracted gate: verbatim/partial pass, extrapolatory degrades.
 *   4. Per-item failure → degraded skeleton node + dead_letter; the batch
 *      survives.
 *
 * Kind dispatch is deterministic — never model-chosen:
 *   fabric 'product' + cve/cwe tag → 'vulnerability' (identifierKind cve|cwe)
 *   fabric 'product'               → 'product'
 *   fabric 'metadata'              → 'metadata'
 *   anything else (invalid events, bindings, patches, non-fabric) → 'unknown'
 */

import { z } from 'zod';
import {
	generateStructured,
	type AIKind,
	type AIResult,
	type CallLLM
} from '../output';
import { writeDeadLetter } from '../deadLetter';
import { bestIdentifier, projectSkeleton, tagValues } from '../projector';
import { extractedGate } from '../verifier';
import { resolveGraph, type GraphView, type NostrEvent } from '../../fabric';
import type { ProviderOverrideInput } from '../provider';
import { buildSystemPrompt, DEFAULT_PROFILE } from '../prompts/vocabCcd';
import { IconTokenEnum } from './cards';

export const BATCH_SIZE = 12;

export const NODE_ENTITY_TYPE = 'node';
export const SCHEMA_VERSION = 'nodemv/1.0';

/* ------------------------------------------------------------------ *
 * Zod schemas — one per NodeVM kind (view-models.md §3.5)
 * ------------------------------------------------------------------ */

export const META_TYPES = ['report', 'target', 'maintenance', 'sbom', 'advisory', 'unknown'] as const;
export type MetadataMetaType = (typeof META_TYPES)[number];
const MetaTypeEnum = z.enum(META_TYPES);

const StatusEnum = z.enum(['active', 'retracted', 'unknown']);
const EAL = /^EAL[1-7]\+?$/;

const BaseFields = {
	entityId: z.string().min(1),
	title: z.string().min(1).max(100),
	typeToken: IconTokenEnum,
	status: StatusEnum,
	retracted: z.boolean(),
	isRoot: z.boolean()
};

export const ProductNodeVMSchema = z.object({
	...BaseFields,
	kind: z.literal('product'),
	identifier: z.string().min(1).max(50).optional(),
	updates: z.number().int().nonnegative(),
	assurance: z.string().regex(EAL).optional(),
	scheme: z.string().max(60).optional(),
	bindings: z
		.array(z.object({ metaType: MetaTypeEnum, label: z.string().min(1).max(60) }))
		.max(3)
});

export const VulnerabilityNodeVMSchema = z.object({
	...BaseFields,
	kind: z.literal('vulnerability'),
	identifier: z.string().min(1).max(50),
	identifierKind: z.enum(['cve', 'cwe']),
	severity: z.enum(['Critical', 'High', 'Medium', 'Low', 'Unknown']).optional(),
});

export const MetadataNodeVMSchema = z.object({
	...BaseFields,
	kind: z.literal('metadata'),
	metaType: MetaTypeEnum,
	label: z.string().min(1).max(80),
	size: z.string().max(20).optional(),
	date: z.string().max(20).optional()
});

export const UnknownNodeVMSchema = z.object({
	...BaseFields,
	kind: z.literal('unknown'),
	typeToken: z.enum(['generic', 'document', 'unknown']),
	summary: z.string().min(1).max(140)
});

export const NodeVMSchema = z.discriminatedUnion('kind', [
	ProductNodeVMSchema,
	VulnerabilityNodeVMSchema,
	MetadataNodeVMSchema,
	UnknownNodeVMSchema
]);

export type ProductNodeVM = z.infer<typeof ProductNodeVMSchema>;
export type VulnerabilityNodeVM = z.infer<typeof VulnerabilityNodeVMSchema>;
export type MetadataNodeVM = z.infer<typeof MetadataNodeVMSchema>;
export type UnknownNodeVM = z.infer<typeof UnknownNodeVMSchema>;
export type NodeVM = z.infer<typeof NodeVMSchema>;

/**
 * Lenient page-level draft passed to generateStructured — every field optional;
 * per-item assembly is zod-gated again against the strict per-kind schema.
 */
const NodeDraft = z
	.object({
		title: z.string().optional(),
		typeToken: z.string().optional(),
		status: z.string().optional(),
		isRoot: z.boolean().optional(),
		identifier: z.string().optional(),
		identifierKind: z.string().optional(),
		severity: z.string().optional(),
		metaType: z.string().optional(),
		label: z.string().optional(),
		size: z.string().optional(),
		date: z.string().optional(),
		summary: z.string().optional(),
		assurance: z.string().optional(),
		scheme: z.string().optional()
	})
	.passthrough();
type NodeDraft = z.infer<typeof NodeDraft>;
const nodesPageSchema = z.object({ nodes: z.array(NodeDraft) });

export interface GraphContext {
	rootSummary: string;
	query: string;
}

/** Per-item dead-letter context (same shape as the cards agent). */
export interface DeadLetterCtx {
	entityId: string;
	profile: string;
	model: string;
}

export interface BatchNodeInterpretOptions {
	events: NostrEvent[];
	graphContext: GraphContext;
	profile?: string;
	provider?: ProviderOverrideInput;
	abortSignal?: AbortSignal;
	/** Test seam; defaults to the real generateText transport. */
	callLLM?: CallLLM;
}

/* ------------------------------------------------------------------ *
 * Deterministic backbone
 * ------------------------------------------------------------------ */

interface Deterministic {
	entityId: string;
	kind: NodeVM['kind'];
	retracted: boolean;
	status: z.infer<typeof StatusEnum>;
	updates: number;
	bindings: Array<{ metaType: MetadataMetaType; label: string }>;
	identifier?: string;
	identifierKind?: 'cve' | 'cwe';
	metaType: MetadataMetaType;
	scheme?: string;
	assurance?: string;
}

function isMetaType(v: string): v is MetadataMetaType {
	return (META_TYPES as readonly string[]).includes(v);
}

/** metaType of a metadata event: an m/meta tag naming a known type, else 'unknown'. */
function metaTypeOf(event: NostrEvent): MetadataMetaType {
	for (const key of ['m', 'meta', 'metaType']) {
		for (const v of tagValues(event, key)) {
			if (isMetaType(v)) return v;
		}
	}
	return 'unknown';
}

function clip(s: string, max: number): string {
	const t = s.trim();
	return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** CVE/CWE indicator tags → normalized identifier + kind. */
function vulnIndicator(event: NostrEvent): { identifier: string; identifierKind: 'cve' | 'cwe' } | undefined {
	for (const kindKey of ['cve', 'cwe'] as const) {
		const raw = tagValues(event, kindKey)[0];
		if (raw) return { identifier: raw.replace(/^c[vw]e:/i, ''), identifierKind: kindKey };
	}
	for (const v of tagValues(event, 'identifier')) {
		const m = /^(c[vw]e)[:\-](.+)$/i.exec(v);
		if (m) return { identifier: m[2], identifierKind: m[1].toLowerCase() as 'cve' | 'cwe' };
	}
	return undefined;
}

function deriveStatus(event: NostrEvent, retracted: boolean): z.infer<typeof StatusEnum> {
	if (retracted) return 'retracted';
	const v = tagValues(event, 'status')[0]?.toLowerCase();
	if (v === 'active') return v;
	return 'unknown';
}

function firstLine(event: NostrEvent, max: number): string {
	return clip(event.content.split('\n').find((l) => l.trim().length > 0) ?? '', max);
}

/**
 * Build the deterministic per-event backbone. `view` comes from resolveGraph
 * over the whole batch, so bindings/link labels and retracted flags account
 * for every event the caller can see.
 */
function buildDeterministic(
	event: NostrEvent,
	view: GraphView,
	batch: NostrEvent[]
): Deterministic {
	const node = view.nodes.find((n) => n.id === event.id);

	let kind: NodeVM['kind'] = 'unknown';
	let identifier: string | undefined;
	let identifierKind: 'cve' | 'cwe' | undefined;
	if (node?.type === 'metadata') {
		kind = 'metadata';
	} else if (node?.type === 'product') {
		const vuln = vulnIndicator(event);
		if (vuln) {
			kind = 'vulnerability';
			identifier = vuln.identifier;
			identifierKind = vuln.identifierKind;
		} else {
			kind = 'product';
		}
	}

	const retracted = node?.retracted ?? false;

	// Derived counts from resolver edges: bindings target the root node.
	const inEdges = view.edges.filter((e) => e.target === event.id);
	const bindings: Deterministic['bindings'] = [];
	for (const edge of inEdges.slice(0, 3)) {
		const source = batch.find((b) => b.id === edge.source);
		const metaType = source ? metaTypeOf(source) : 'unknown';
		const label = clip(edge.label, 60) || (source ? firstLine(source, 60) : '');
		if (label) bindings.push({ metaType, label });
	}

	// Updates: patch events in the batch e-tagging this event.
	const updates = batch.filter(
		(b) => tagValues(b, 't').includes('scrutiny-patch') && b.tags.some((t) => t[0] === 'e' && t[1] === event.id)
	).length;

	const identifiers = [
		...tagValues(event, 'identifier'),
		...tagValues(event, 'ccid'),
		...tagValues(event, 'cve'),
		...tagValues(event, 'cwe'),
		...tagValues(event, 'd')
	].filter((v) => v.length > 0);

	return {
		entityId: event.id,
		kind,
		retracted,
		status: deriveStatus(event, retracted),
		updates,
		bindings,
		identifier: identifier ?? (identifiers[0] || undefined),
		identifierKind,
		metaType: kind === 'metadata' ? metaTypeOf(event) : 'unknown',
		scheme: tagValues(event, 'scheme')[0] || undefined,
		assurance: tagValues(event, 'eal').find((v) => EAL.test(v)) ?? undefined
	};
}

/* ------------------------------------------------------------------ *
 * Finalization
 * ------------------------------------------------------------------ */

function draftText(v: string | undefined): string | undefined {
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function skeletonTitle(event: NostrEvent): string {
	return bestIdentifier(event) ?? projectSkeleton(event, { boundMetadata: 0, attachments: 0, updates: 0 }).title;
}

/** Degraded node: tags+resolver-only fields, no LLM content. Always parses. */
function degradedNode(event: NostrEvent, det: Deterministic): NodeVM {
	const base = {
		entityId: det.entityId,
		title: clip(skeletonTitle(event), 100),
		typeToken: 'unknown' as const,
		status: det.status,
		retracted: det.retracted,
		isRoot: false
	};
	switch (det.kind) {
		case 'product':
			return {
				...base,
				kind: 'product',
				...(det.identifier ? { identifier: det.identifier } : {}),
				updates: det.updates,
				...(det.assurance ? { assurance: det.assurance } : {}),
				...(det.scheme ? { scheme: det.scheme } : {}),
				bindings: det.bindings
			};
		case 'vulnerability':
			return {
				...base,
				kind: 'vulnerability',
				identifier: det.identifier ?? clip(det.entityId, 50),
				identifierKind: det.identifierKind ?? 'cve'
			};
		case 'metadata':
			return {
				...base,
				kind: 'metadata',
				metaType: det.metaType,
				label: firstLine(event, 80) || clip(det.entityId, 80)
			};
		case 'unknown':
			return {
				...base,
				kind: 'unknown',
				typeToken: 'unknown',
				summary: clip(event.content, 140) || 'No interpretable content.'
			};
	}
}

function finalizeNode(
	event: NostrEvent,
	det: Deterministic,
	draft: NodeDraft | undefined,
	ctx: DeadLetterCtx
): NodeVM {
	const base = {
		entityId: det.entityId,
		title: clip(draftText(draft?.title) ?? skeletonTitle(event), 100) || clip(det.entityId, 100),
		typeToken: IconTokenEnum.safeParse(draft?.typeToken).success
			? IconTokenEnum.parse(draft?.typeToken)
			: ('unknown' as const),
		status: det.status,
		retracted: det.retracted,
		isRoot: draft?.isRoot === true
	};

	let candidate: unknown;
	let schema: z.ZodType<NodeVM>;
	switch (det.kind) {
		case 'product':
			candidate = {
				...base,
				kind: 'product',
				identifier: draftText(draft?.identifier) ?? det.identifier,
				updates: det.updates,
				assurance: det.assurance,
				scheme: draftText(draft?.scheme) ?? det.scheme,
				bindings: det.bindings
			};
			schema = ProductNodeVMSchema;
			break;
		case 'vulnerability':
			candidate = {
				...base,
				kind: 'vulnerability',
				identifier: draftText(draft?.identifier) ?? det.identifier,
				identifierKind:
					draft?.identifierKind === 'cwe' || draft?.identifierKind === 'cve'
						? draft.identifierKind
						: det.identifierKind,
				severity: draftText(draft?.severity)
			};
			schema = VulnerabilityNodeVMSchema;
			break;
		case 'metadata':
			candidate = {
				...base,
				kind: 'metadata',
				metaType: isMetaType(draft?.metaType ?? '') ? (draft?.metaType as MetadataMetaType) : det.metaType,
				label: clip(draftText(draft?.label) ?? firstLine(event, 80), 80),
				size: draftText(draft?.size),
				date: draftText(draft?.date)
			};
			schema = MetadataNodeVMSchema;
			break;
		case 'unknown': {
			let summary = clip(draftText(draft?.summary) ?? '', 140);
			if (summary) {
				const gate = extractedGate(summary, event.content);
				if (gate.state === 'extrapolatory') {
					// Quote verification failed: the summary cites nothing on the event.
					writeDeadLetter({
						entityType: NODE_ENTITY_TYPE,
						entityId: ctx.entityId,
						schemaVersion: SCHEMA_VERSION,
						profile: ctx.profile,
						model: ctx.model,
						payload: { summary: draft?.summary },
						reason: 'summary extrapolatory (quote gate found no contiguous match in event content)'
					});
					summary = '';
				}
			}
			candidate = {
				...base,
				kind: 'unknown',
				typeToken: ['generic', 'document', 'unknown'].includes(draft?.typeToken ?? '')
					? (draft?.typeToken as 'generic' | 'document' | 'unknown')
					: 'unknown',
				summary: summary || clip(event.content, 140) || 'No interpretable content.'
			};
			schema = UnknownNodeVMSchema;
			break;
		}
	}

	const parsed = schema.safeParse(candidate);
	if (parsed.success) return parsed.data;

	// Per-item failure → degrade this node, keep the batch.
	const reason = parsed.error.issues
		.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
		.join('; ');
	writeDeadLetter({
		entityType: NODE_ENTITY_TYPE,
		entityId: ctx.entityId,
		schemaVersion: SCHEMA_VERSION,
		profile: ctx.profile,
		model: ctx.model,
		payload: candidate,
		reason: `node validation failed: ${reason}`
	});
	return degradedNode(event, det);
}

/* ------------------------------------------------------------------ *
 * batchNodeInterpret — batch pipeline
 * ------------------------------------------------------------------ */

function mapKind(kind: AIKind): AIKind {
	// Same convention as the cards agent: timeouts surface as unreachable.
	if (kind === 'timeout') return 'unreachable';
	return kind;
}

export async function batchNodeInterpret(
	opts: BatchNodeInterpretOptions
): Promise<AIResult<{ nodes: NodeVM[] }>> {
	const events = opts.events;
	const view = resolveGraph(events);
	const profile = opts.profile ?? DEFAULT_PROFILE;
	const model = opts.provider?.model ?? 'unspecified';
	const system = buildSystemPrompt({ profile });

	const dets = events.map((e) => buildDeterministic(e, view, events));

	const nodes: NodeVM[] = [];
	for (let i = 0; i < events.length; i += BATCH_SIZE) {
		const pageEvents = events.slice(i, i + BATCH_SIZE);
		const pageDets = dets.slice(i, i + BATCH_SIZE);
		const payload = JSON.stringify({
			graphContext: opts.graphContext,
			events: pageEvents.map((e, j) => ({
				entityId: e.id,
				kind: pageDets[j].kind,
				retracted: pageDets[j].retracted,
				tags: e.tags,
				content: e.content
			}))
		});

		const res = await generateStructured({
			schema: nodesPageSchema,
			system,
			messages: [
				{
					role: 'user',
					content: [
						'Interpret each event into one node object, in the SAME ORDER as the input.',
						'The `kind` and `retracted` fields per event are pre-decided — do NOT change them; supply only the content fields for that kind:',
						'- product: {title ≤100 chars, typeToken (icon token), identifier?, scheme?, isRoot?}',
						'- vulnerability: {title, typeToken, identifier (CVE/CWE string), identifierKind, severity?, isRoot?}',
						'- metadata: {title, typeToken, metaType (report|target|maintenance|sbom|advisory|unknown), label ≤80 chars, size?, date?, isRoot?}',
						'- unknown: {title, typeToken (generic|document|unknown), summary ≤140 chars quoting the event content closely, isRoot?}',
						'',
						payload,
						'',
						'Respond with JSON only, no prose. Return an object {"nodes":[ ... one object per event, in order ... ]}.'
					].join('\n')
				}
			],
			provider: opts.provider,
			callLLM: opts.callLLM,
			abortSignal: opts.abortSignal
		});

		if (!res.ok) {
			if (res.kind === 'schema_failure') {
				return { ok: false, kind: 'schema_failure', message: res.message };
			}
			const kind = mapKind(res.kind);
			return { ok: false, kind, message: res.message };
		}

		const drafts = res.result.nodes;
		for (let j = 0; j < pageEvents.length; j++) {
			const ctx: DeadLetterCtx = {
				entityId: pageEvents[j].id,
				profile,
				model
			};
			nodes.push(finalizeNode(pageEvents[j], pageDets[j], drafts[j], ctx));
		}
	}

	return { ok: true, result: { nodes } };
}
