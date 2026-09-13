# Scrutiny Lens

The single surface vocabulary for the static SPA that lets an analyst search Nostr relays, facet the results, and inspect individual events. Terms here are the language issues, PRs, and code comments must use.

## Language

**Selection**:
The single event the user has opened for detail, held as an event id at investigation level. It is store-level state: facet filters, view changes, and drawer open/collapse never clear it; only a new investigation or an explicit deselect does.
_Avoid_: highlighted card, active card, focused result

**Dossier**:
The detail drawer's body for the Selection — the four sections Summary, Content, History, Files, rendered entirely from deterministic event data plus cached AI prose.
_Avoid_: details pane, inspector, drawer content

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
