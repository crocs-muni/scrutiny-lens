# Selection is store-level and outlives facet filtering

Selected event detail (the dossier) reads from the investigation's full admitted event store, not from the facet-filtered visible card list. Facet filters change which cards render; they never clear or alter the selection, so a dossier keeps rendering truthful event data even when its card is filtered out of the results list.

Chosen over view-coupled selection (clear the dossier when the card is filtered away) for three reasons. First, the never-lie rule: a view operation that hides a card changes zero facts about the event, so making the dossier disappear would look like evidence vanishing — and absence cannot be annotated to mean "still exists, just filtered." Second, the codebase already separates view state (`selections`, a `$derived` projection) from the store (`admitted`, `cards`); view-coupled selection would make filters a competing writer of selection state. Third, master-detail precedent (VS Code editor tabs, Material list-detail) keeps selection stable across list filtering.

The known cost — a persisted-but-invisible selection reads as detached from the list — is treated as an affordance problem, not a state problem: when the selected event is hidden by the current facets, the UI must announce it (the "hidden by filter" state in CONTEXT.md) rather than render the dossier silently.

Owner-ruled 2026-09-13 during #29a planning.
