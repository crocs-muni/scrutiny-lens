# Scrutiny Lens

The single surface vocabulary for the static SPA that lets an analyst search Nostr relays, facet the results, and inspect individual events. Terms here are the language issues, PRs, and code comments must use.

## Language

**Selection**:
The single event the user has opened for detail, held as an event id at investigation level. It is store-level state: facet filters, view changes, and drawer open/collapse never clear it; only a new investigation or an explicit deselect does.
_Avoid_: highlighted card, active card, focused result

**Dossier**:
The detail drawer's body for the Selection — the four sections Summary, Content, History, Files, rendered entirely from deterministic event data plus cached AI prose. The Files section lists the subject's **Artifacts** (own descriptors first, "this record", then one row per artifact per bound record with verb chip + counterparty deep-link) — never "bindings", never "any URL".
_Avoid_: details pane, inspector, drawer content

**Artifact**:
A file described by a record — the record's own deliverable: an `imeta` tag's url (primary tier) or a conservative legacy-in-content descriptor line (fallback tier, extension-whitelisted). Artifacts are extracted from exactly one seam (`artifacts.ts`); counts, drawer rows, and footers never re-judge "URL in content" anywhere else.
_Avoid_: attachment, download, linked file, binding row

**Facet filter**:
View-level state that projects which cards the results list shows. It filters the list only; it never filters the underlying admitted events and never touches the Selection.
_Avoid_: filter, search refinement (unqualified)

**Show deleted**:
The enumeration-surface toggle that reveals retracted events in lists and on the canvas. It de-clutters enumeration only; it is never an access control — a dossier the user explicitly opened always renders, retraction included, flagged with the red pill.
_Avoid_: hide retractions, deleted filter

**Hidden by filter**:
The announced state where the Selection's event is not among the facet-filtered visible cards. The dossier keeps rendering but the UI must announce this state on both surfaces — a line on the dossier itself and a line where the filtering happened; it is never silent.
_Avoid_: stale selection, orphaned dossier

**Citation**:
A chat answer's numbered reference to one admitted event, carrying a computed verbatim quote span. Numbers are pinned per conversation — an event keeps its number and its paired color for the whole chat, reloads included (ADR 0003).
_Avoid_: reference, source, link

**Claim span**:
The sentence of an AI-written chat answer that a citation supports, computed deterministically from the marker position. It is a hover/click target — dotted underline in the citation's paired color — only while its citation verifies.
_Avoid_: sentence highlight, grounding span

**Inert claim**:
AI-written chat prose whose citation failed verbatim verification. The citation is dropped silently; the prose renders with no pill, no underline, no affordance (ADR 0003).
_Avoid_: unverified pill, flagged claim

**Coordination store**:
The chat → surface link state that maps a citation to its claim span, its hover-card, and the target it can focus — pre-canvas: the dossier; post-#29b: the graph node ring. One-directional this cycle: hovering a node never lights chat.
_Avoid_: focus store, sync store

**Subject** (subject graph):
The centered event the canvas's subject graph is drawn around — the first dossier subject opened in an investigation. Later selections move the ring and the dossier but never re-center the graph; the subject dies with the investigation. Normally a product; a linked record can also be centered (spec §9 glossary).
_Avoid_: hub, graph root, ego anchor, center node, anchor card

**Linked record**:
A metadata record bound to the subject — a node on the canvas, a paragraph in the record register, the counterparty an artifact row points at.
_Avoid_: spoke, metadata node (unqualified)

**Related product**:
A product sharing a linked record with the subject, not expanded — drawn dimmed further out along the shared record's ray, with a +N badge counting its admitted-but-unrevealed neighbors. Not a placeholder: every one is an admitted event with an admitted binding.
_Avoid_: shadow hub, ghost node, stub, latent hub

**Expansion**:
The gesture (double-click on a related product, undo chip in the toolbar) that reveals a related product's admitted neighbors in place. Admitted-only — expansion never fetches; a neighbor the store can't show is counted in +N, never invented.
_Avoid_: drill-down, lazy load, infinite graph
