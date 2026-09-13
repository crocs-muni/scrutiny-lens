# Chat grounds and cites the full admitted set

The session chat may ground its answers on, and cite events from, the investigation's full admitted event store — not only the facet-visible subset. Facet filters change which cards render; they never shrink what the chat is allowed to say, for the same reason ADR 0001 keeps the dossier bound to the store rather than the view: a view operation changes zero facts about the evidence, so letting filters narrow the chat's grounding would make the same question answer differently depending on which chips are toggled.

Chosen over the literal "on-screen" reading of spec §2 rule 3 (spec §2's phrase predates the facet vocabulary; issue #30's own wording is "the session's event set"). The facet-hybrid — cite the admitted set but badge pills whose event is currently filtered out — adds chrome for information the existing hidden-by-filter announcement already gives on navigation.

The cost is that a citation can point at an event whose card is filtered away. It is absorbed by the same mechanism ADR 0001 built: opening a citation's dossier goes through the store-level selection, and when the card is hidden the dossier renders anyway with the hidden-by-filter announcement. When #29b lands, the canvas subsumes this: the graph shows all admitted events.

Consequence in code: the ported `chatground()` parameter named `visibleEvents` (and its prompt's "visible nodes" language) is re-purposed as the grounding set = the session's admitted events; the rename happens with #30 and the locked rule becomes "every citation resolves to an admitted event id".

Owner-ruled 2026-09-14 during #30 planning.
