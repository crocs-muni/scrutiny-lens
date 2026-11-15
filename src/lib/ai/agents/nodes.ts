/**
 * W5 · Node agent — batched node interpretation (visible events → NodeVM[]).
 *
 * Pipeline (same batch pattern as the cards agent):
 *   1. Deterministic backbone per event: kind dispatch from the fabric
 *      (`resolveGraph` — validateAndClassify groupings; `retracted` carried
 *      from the resolver), status from tags, identifiers from known tag keys,
 *      bindings / updates from the resolver's edges.
 *   2. LLM drafts KV records per page of BATCH_SIZE events (one record per
 *      event, bound by the echoed `entityId`; issue #52 format).
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

import { z } from "zod";
import { type AIKind, type AIResult, type CallLLM } from "../output";
import { generateRecords, streamRecords, type StreamLLM } from "../records";
import { writeDeadLetter } from "../deadLetter";
import { bestIdentifier, projectSkeleton, tagValues } from "../projector";
import { extractedGate } from "../verifier";
import { canonicalContentOf } from "../canonical";
import { resolveGraph, type GraphView, type NostrEvent } from "../../fabric";
import type { ProviderOverrideInput } from "../provider";
import { buildSystemPrompt, DEFAULT_PROFILE } from "../prompts/vocabCcd";
import { IconTokenEnum } from "./cards";

/** Events per LLM call. Four, not twelve: the interpret lane's per-attempt
 * budget is the gateway's 30s, and a cold gpt-oss-120b run needs ~34s for a
 * dozen records (measured 2026-11-08 on the Athena corpus, 12 nodes ≈ 34s →
 * every node stayed rule-5). Four records land in ~11s and page serially,
 * which also paints the trickle sooner instead of one lump at the end. */
export const BATCH_SIZE = 4;

export const NODE_ENTITY_TYPE = "node";
export const SCHEMA_VERSION = "nodemv/1.0";

/* ------------------------------------------------------------------ *
 * Zod schemas — one per NodeVM kind (view-models.md §3.5)
 * ------------------------------------------------------------------ */

export const META_TYPES = [
  "report",
  "target",
  "maintenance",
  "sbom",
  "advisory",
  "unknown",
] as const;
export type MetadataMetaType = (typeof META_TYPES)[number];
const MetaTypeEnum = z.enum(META_TYPES);

const StatusEnum = z.enum(["active", "retracted", "unknown"]);
const EAL = /^EAL[1-7]\+?$/;

const BaseFields = {
  entityId: z.string().min(1),
  title: z.string().min(1).max(100),
  typeToken: IconTokenEnum,
  status: StatusEnum,
  retracted: z.boolean(),
  isRoot: z.boolean(),
};

export const ProductNodeVMSchema = z.object({
  ...BaseFields,
  kind: z.literal("product"),
  identifier: z.string().min(1).max(50).optional(),
  updates: z.number().int().nonnegative(),
  assurance: z.string().regex(EAL).optional(),
  scheme: z.string().max(60).optional(),
  bindings: z
    .array(
      z.object({ metaType: MetaTypeEnum, label: z.string().min(1).max(60) }),
    )
    .max(3),
});

export const VulnerabilityNodeVMSchema = z.object({
  ...BaseFields,
  kind: z.literal("vulnerability"),
  identifier: z.string().min(1).max(50),
  identifierKind: z.enum(["cve", "cwe"]),
  severity: z.enum(["Critical", "High", "Medium", "Low", "Unknown"]).optional(),
});

export const MetadataNodeVMSchema = z.object({
  ...BaseFields,
  kind: z.literal("metadata"),
  metaType: MetaTypeEnum,
  label: z.string().min(1).max(80),
  size: z.string().max(20).optional(),
  date: z.string().max(20).optional(),
});

export const UnknownNodeVMSchema = z.object({
  ...BaseFields,
  kind: z.literal("unknown"),
  typeToken: z.enum(["generic", "document", "unknown"]),
  summary: z.string().min(1).max(140),
});

export const NodeVMSchema = z.discriminatedUnion("kind", [
  ProductNodeVMSchema,
  VulnerabilityNodeVMSchema,
  MetadataNodeVMSchema,
  UnknownNodeVMSchema,
]);

export type ProductNodeVM = z.infer<typeof ProductNodeVMSchema>;
export type VulnerabilityNodeVM = z.infer<typeof VulnerabilityNodeVMSchema>;
export type MetadataNodeVM = z.infer<typeof MetadataNodeVMSchema>;
export type UnknownNodeVM = z.infer<typeof UnknownNodeVMSchema>;
export type NodeVM = z.infer<typeof NodeVMSchema>;

/**
 * Lenient per-record draft (KV, issue #52) — every field optional; per-item
 * assembly is zod-gated again against the strict per-kind schema. `entityId`
 * binds the record back to its event (id-binding replaces positional order —
 * a salvaged partial page must not shift records onto the wrong events).
 */
const NodeDraft = z
  .object({
    entityId: z.string().min(1),
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
    scheme: z.string().optional(),
  })
  .passthrough();
type NodeDraft = z.infer<typeof NodeDraft>;

/** Keys the model may emit — the KV classifier's known set (issue #52). */
const NODE_KEYS = [
  "entityId",
  "title",
  "typeToken",
  "status",
  "isRoot",
  "identifier",
  "identifierKind",
  "severity",
  "metaType",
  "label",
  "size",
  "date",
  "summary",
  "assurance",
  "scheme",
] as const;

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
  /** Progressive paint: with BOTH a stream seam and a callback, each page is
   * read through streamRecords and every record the model CLOSES is finalized
   * through the same gate the settled list gets (id affinity + per-kind schema
   * + quote gate) and reported immediately. records.ts's contract holds: this
   * is an earlier view of the same truth, never additional truth — the settled
   * page still returns the authoritative list (callers dedupe per id). */
  streamLLM?: StreamLLM;
  onNode?: (vm: NodeVM) => void;
}

/* ------------------------------------------------------------------ *
 * Deterministic backbone
 * ------------------------------------------------------------------ */

interface Deterministic {
  entityId: string;
  kind: NodeVM["kind"];
  retracted: boolean;
  status: z.infer<typeof StatusEnum>;
  updates: number;
  bindings: Array<{ metaType: MetadataMetaType; label: string }>;
  identifier?: string;
  identifierKind?: "cve" | "cwe";
  metaType: MetadataMetaType;
  scheme?: string;
  assurance?: string;
}

function isMetaType(v: string): v is MetadataMetaType {
  return (META_TYPES as readonly string[]).includes(v);
}

/** metaType of a metadata event: an m/meta tag naming a known type, else 'unknown'. */
function metaTypeOf(event: NostrEvent): MetadataMetaType {
  for (const key of ["m", "meta", "metaType"]) {
    for (const v of tagValues(event, key)) {
      if (isMetaType(v)) return v;
    }
  }
  return "unknown";
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** CVE/CWE indicator tags → normalized identifier + kind. */
function vulnIndicator(
  event: NostrEvent,
): { identifier: string; identifierKind: "cve" | "cwe" } | undefined {
  for (const kindKey of ["cve", "cwe"] as const) {
    const raw = tagValues(event, kindKey)[0];
    if (raw)
      return {
        identifier: raw.replace(/^c[vw]e:/i, ""),
        identifierKind: kindKey,
      };
  }
  for (const v of tagValues(event, "identifier")) {
    const m = /^(c[vw]e)[:\-](.+)$/i.exec(v);
    if (m)
      return {
        identifier: m[2],
        identifierKind: m[1].toLowerCase() as "cve" | "cwe",
      };
  }
  return undefined;
}

function deriveStatus(
  event: NostrEvent,
  retracted: boolean,
): z.infer<typeof StatusEnum> {
  if (retracted) return "retracted";
  const v = tagValues(event, "status")[0]?.toLowerCase();
  if (v === "active") return v;
  return "unknown";
}

function firstLine(event: NostrEvent, max: number): string {
  return clip(
    event.content.split("\n").find((l) => l.trim().length > 0) ?? "",
    max,
  );
}

/**
 * Build the deterministic per-event backbone. `view` comes from resolveGraph
 * over the whole batch, so bindings/link labels and retracted flags account
 * for every event the caller can see.
 */
function buildDeterministic(
  event: NostrEvent,
  view: GraphView,
  batch: NostrEvent[],
): Deterministic {
  const node = view.nodes.find((n) => n.id === event.id);

  let kind: NodeVM["kind"] = "unknown";
  let identifier: string | undefined;
  let identifierKind: "cve" | "cwe" | undefined;
  if (node?.type === "metadata") {
    kind = "metadata";
  } else if (node?.type === "product") {
    const vuln = vulnIndicator(event);
    if (vuln) {
      kind = "vulnerability";
      identifier = vuln.identifier;
      identifierKind = vuln.identifierKind;
    } else {
      kind = "product";
    }
  }

  const retracted = node?.retracted ?? false;

  // Derived counts from resolver edges: bindings target the root node.
  const inEdges = view.edges.filter((e) => e.target === event.id);
  const bindings: Deterministic["bindings"] = [];
  for (const edge of inEdges.slice(0, 3)) {
    const source = batch.find((b) => b.id === edge.source);
    const metaType = source ? metaTypeOf(source) : "unknown";
    const label = clip(edge.label, 60) || (source ? firstLine(source, 60) : "");
    if (label) bindings.push({ metaType, label });
  }

  // Updates: patch events in the batch e-tagging this event.
  const updates = batch.filter(
    (b) =>
      tagValues(b, "t").includes("scrutiny-patch") &&
      b.tags.some((t) => t[0] === "e" && t[1] === event.id),
  ).length;

  const identifiers = [
    ...tagValues(event, "identifier"),
    ...tagValues(event, "ccid"),
    ...tagValues(event, "cve"),
    ...tagValues(event, "cwe"),
    ...tagValues(event, "d"),
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
    metaType: kind === "metadata" ? metaTypeOf(event) : "unknown",
    scheme: tagValues(event, "scheme")[0] || undefined,
    assurance: tagValues(event, "eal").find((v) => EAL.test(v)) ?? undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Finalization
 * ------------------------------------------------------------------ */

function draftText(v: string | undefined): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function skeletonTitle(event: NostrEvent): string {
  return (
    bestIdentifier(event) ??
    projectSkeleton(event, { boundMetadata: 0, attachments: 0, updates: 0 })
      .title
  );
}

/** Degraded node: tags+resolver-only fields, no LLM content. Always parses. */
function degradedNode(event: NostrEvent, det: Deterministic): NodeVM {
  const base = {
    entityId: det.entityId,
    title: clip(skeletonTitle(event), 100),
    typeToken: "unknown" as const,
    status: det.status,
    retracted: det.retracted,
    isRoot: false,
  };
  switch (det.kind) {
    case "product":
      return {
        ...base,
        kind: "product",
        ...(det.identifier ? { identifier: det.identifier } : {}),
        updates: det.updates,
        ...(det.assurance ? { assurance: det.assurance } : {}),
        ...(det.scheme ? { scheme: det.scheme } : {}),
        bindings: det.bindings,
      };
    case "vulnerability":
      return {
        ...base,
        kind: "vulnerability",
        identifier: det.identifier ?? clip(det.entityId, 50),
        identifierKind: det.identifierKind ?? "cve",
      };
    case "metadata":
      return {
        ...base,
        kind: "metadata",
        metaType: det.metaType,
        label: firstLine(event, 80) || clip(det.entityId, 80),
      };
    case "unknown":
      return {
        ...base,
        kind: "unknown",
        typeToken: "unknown",
        summary: clip(event.content, 140) || "No interpretable content.",
      };
  }
}

/** `fromDraft` marks a model-backed interpretation (draft present AND
 * its assembly survived the strict gate) vs a deterministic degraded
 * skeleton — the cache may persist only the former (spec §2 never-lie:
 * a skeleton fed back on the next visit would READ as interpretation). */
function finalizeNode(
  event: NostrEvent,
  det: Deterministic,
  draft: NodeDraft | undefined,
  ctx: DeadLetterCtx,
  canonical: ReadonlyMap<string, string>,
): { vm: NodeVM; fromDraft: boolean } {
  const base = {
    entityId: det.entityId,
    title:
      clip(draftText(draft?.title) ?? skeletonTitle(event), 100) ||
      clip(det.entityId, 100),
    typeToken: IconTokenEnum.safeParse(draft?.typeToken).success
      ? IconTokenEnum.parse(draft?.typeToken)
      : ("unknown" as const),
    status: det.status,
    retracted: det.retracted,
    isRoot: draft?.isRoot === true,
  };

  let candidate: unknown;
  let schema: z.ZodType<NodeVM>;
  switch (det.kind) {
    case "product":
      candidate = {
        ...base,
        kind: "product",
        identifier: draftText(draft?.identifier) ?? det.identifier,
        updates: det.updates,
        assurance: det.assurance,
        scheme: draftText(draft?.scheme) ?? det.scheme,
        bindings: det.bindings,
      };
      schema = ProductNodeVMSchema;
      break;
    case "vulnerability":
      candidate = {
        ...base,
        kind: "vulnerability",
        identifier: draftText(draft?.identifier) ?? det.identifier,
        identifierKind:
          draft?.identifierKind === "cwe" || draft?.identifierKind === "cve"
            ? draft.identifierKind
            : det.identifierKind,
        severity: draftText(draft?.severity),
      };
      schema = VulnerabilityNodeVMSchema;
      break;
    case "metadata":
      candidate = {
        ...base,
        kind: "metadata",
        metaType: isMetaType(draft?.metaType ?? "")
          ? (draft?.metaType as MetadataMetaType)
          : det.metaType,
        label: clip(draftText(draft?.label) ?? firstLine(event, 80), 80),
        size: draftText(draft?.size),
        date: draftText(draft?.date),
      };
      schema = MetadataNodeVMSchema;
      break;
    case "unknown": {
      // #163: everything this branch renders comes from ONE text — the
      // resolved content. Gating against canonical while feeding the model
      // (and falling back to) raw text made a patched node dead-letter and
      // then paint the stale pre-patch prose anyway.
      const text = canonical.get(event.id) ?? event.content;
      let summary = clip(draftText(draft?.summary) ?? "", 140);
      if (summary) {
        const gate = extractedGate(summary, text);
        if (gate.state === "extrapolatory") {
          // Quote verification failed: the summary cites nothing on the event.
          writeDeadLetter({
            entityType: NODE_ENTITY_TYPE,
            entityId: ctx.entityId,
            schemaVersion: SCHEMA_VERSION,
            profile: ctx.profile,
            model: ctx.model,
            payload: { summary: draft?.summary },
            reason:
              "summary extrapolatory (quote gate found no contiguous match in the resolved content)",
          });
          summary = "";
        }
      }
      candidate = {
        ...base,
        kind: "unknown",
        typeToken: ["generic", "document", "unknown"].includes(
          draft?.typeToken ?? "",
        )
          ? (draft?.typeToken as "generic" | "document" | "unknown")
          : "unknown",
        summary: summary || clip(text, 140) || "No interpretable content.",
      };
      schema = UnknownNodeVMSchema;
      break;
    }
  }

  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { vm: parsed.data, fromDraft: draft !== undefined };

  // Per-item failure → degrade this node, keep the batch.
  const reason = parsed.error.issues
    .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("; ");
  writeDeadLetter({
    entityType: NODE_ENTITY_TYPE,
    entityId: ctx.entityId,
    schemaVersion: SCHEMA_VERSION,
    profile: ctx.profile,
    model: ctx.model,
    payload: candidate,
    reason: `node validation failed: ${reason}`,
  });
  return { vm: degradedNode(event, det), fromDraft: false };
}

/* ------------------------------------------------------------------ *
 * batchNodeInterpret — batch pipeline
 * ------------------------------------------------------------------ */

function mapKind(kind: AIKind): AIKind {
  // Same convention as the cards agent: timeouts surface as unreachable.
  if (kind === "timeout") return "unreachable";
  return kind;
}

export async function batchNodeInterpret(
  opts: BatchNodeInterpretOptions,
): Promise<AIResult<{ nodes: NodeVM[]; interpretedIds: string[] }>> {
  const events = opts.events;
  const view = resolveGraph(events);
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const model = opts.provider?.model ?? "unspecified";
  const system = buildSystemPrompt({ profile });

  const dets = events.map((e) => buildDeterministic(e, view, events));

  // #163: resolve every event's canonical content ONCE per call, and give the
  // same map to the payload the model reads, the quote gate, and the fallback
  // — one text per node, so a gate failure can never be a raw/canonical
  // mismatch. Also removes the per-node O(n) resolve() the first cut paid.
  const canonical = new Map<string, string>();
  for (const e of events) {
    const text = canonicalContentOf(e.id, events);
    if (text !== undefined) canonical.set(e.id, text);
  }

  const nodes: NodeVM[] = [];
  // Model-backed records only — degraded skeletons stay out of this list,
  // so a consumer (the cache) can persist interpretations without ever
  // persisting a fallback dressed as one.
  const interpretedIds: string[] = [];
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
        // Payload clip (owner ruling 2026-09-16): the node's interpretation
        // needs the event's own prose, not its full artifact dump — these
        // bytes leave the browser for the BYOK endpoint, so 400 chars is
        // the privacy + token ceiling (cards clip at 200; nodes keep a
        // little more because the title has to name the artifact).
        // Canonical (#163): the model must read the same bytes the gate
        // verifies against, or a patched node is summarised from history and
        // then rejected for not matching the present.
        content: clip(canonical.get(e.id) ?? e.content, 400),
      })),
    });

    // One record per event, bound by the echoed entityId BEFORE any paint:
    // a mangled id must never paste another event's text onto this one
    // (spec §2, id-mangling incident).
    const requested = new Set(pageEvents.map((e) => e.id));
    const deadLetterCtx = (j: number): DeadLetterCtx => ({
      entityId: pageEvents[j].id,
      profile,
      model,
    });
    /** Progressive paint: the closed record goes through the same
     * finalizeNode gate the settled list uses (affinity, per-kind schema,
     * quote gate), so a half-described or extrapolatory record never paints
     * and nothing here can outrun the settled truth. A repeat of an
     * already-claimed id is dropped, exactly as the settled binder drops it —
     * a model echoing one entityId twice must not paint twice or write two
     * dead letters. */
    const paintClosed = (onNode: (vm: NodeVM) => void) => {
      const claimed = new Set<string>();
      return (draft: NodeDraft): void => {
        if (claimed.has(draft.entityId)) return; // repeat echo
        const j = pageEvents.findIndex((e) => e.id === draft.entityId);
        if (j < 0) return; // foreign echo — the page's ids only
        claimed.add(draft.entityId);
        const { vm, fromDraft } = finalizeNode(
          pageEvents[j],
          pageDets[j],
          draft,
          deadLetterCtx(j),
          canonical,
        );
        if (fromDraft) onNode(vm);
      };
    };
    const reader = {
      schema: NodeDraft,
      knownKeys: NODE_KEYS,
      booleans: ["isRoot"],
      system,
      messages: [
        {
          role: "user" as const,
          content: [
            "Interpret each event into one record, echoing its `entityId` EXACTLY.",
            "The `kind` and `retracted` fields per event are pre-decided — do NOT change them; supply only the content fields for that kind:",
            "- product: {title ≤100 chars, typeToken (icon token), identifier?, scheme?, isRoot?}",
            "- vulnerability: {title, typeToken, identifier (CVE/CWE string), identifierKind, severity?, isRoot?}",
            "- metadata: {title, typeToken, metaType (report|target|maintenance|sbom|advisory|unknown), label ≤80 chars, size?, date?, isRoot?}",
            "- unknown: {title, typeToken (generic|document|unknown), summary ≤140 chars quoting the event content closely, isRoot?}",
            "",
            "",
            payload,
            "",
            "Emit one record per event: `entityId: <the id>` plus the fields above. `isRoot` is true/false.",
          ].join("\n"),
        },
      ],
      provider: opts.provider,
      abortSignal: opts.abortSignal,
      // Interpret lane (issue #107): cap a reasoning model's hidden
      // thinking where the endpoint honors it.
      reasoningEffort: "low" as const,
    };
    // Progressively painted pages read the same prompt through the stream so
    // each closed record paints before the page settles; without both seams
    // the batch reader stays the default (tests, and any caller that wants one
    // lump). Settle semantics are identical: streamRecords ends on the same
    // authoritative parse of the full text.
    const res =
      opts.streamLLM !== undefined && opts.onNode !== undefined
        ? await streamRecords<NodeDraft>({
            ...reader,
            streamLLM: opts.streamLLM,
            onRecord: paintClosed(opts.onNode),
          })
        : await generateRecords<NodeDraft>({
            ...reader,
            callLLM: opts.callLLM,
          });

    if (!res.ok) {
      if (res.kind === "schema_failure") {
        return { ok: false, kind: "schema_failure", message: res.message };
      }
      const kind = mapKind(res.kind);
      return { ok: false, kind, message: res.message };
    }

    // Id-binding: a salvaged partial page maps by entityId, never by
    // position — a dropped record degrades only its own event; foreign
    // echoes and repeats are dropped.
    const drafts = new Map<string, NodeDraft>();
    for (const draft of res.result) {
      if (!requested.has(draft.entityId) || drafts.has(draft.entityId)) continue;
      drafts.set(draft.entityId, draft);
    }
    for (let j = 0; j < pageEvents.length; j++) {
      const { vm, fromDraft } = finalizeNode(
        pageEvents[j],
        pageDets[j],
        drafts.get(pageEvents[j].id),
        deadLetterCtx(j),
        canonical,
      );
      nodes.push(vm);
      if (fromDraft) interpretedIds.push(vm.entityId);
    }
  }

  return { ok: true, result: { nodes, interpretedIds } };
}
