# Trust is admission, not a facet

The curated trusted-publisher list defines the session's admitted view: records by a listed key, records reached through a listed key's Binding, and the canonical chains of admitted roots. Chain construction and traversal run over the full observed set (fabric TR-7); the trusted view is applied after. Chat grounds on that view, so ADR 0002 is unchanged in spirit: facets never narrow grounding, and trust is not a facet. The observed set stays available to the dossier's history and the fetch lanes.

The list ships as a reviewed file with the build and can be changed on this device (add or remove one key at a time). It is never uploaded. A record whose author is listed is the default and carries no marker; the dossier names the path only when a Binding, not the author's own key, is the reason the record is visible.

The alternative — a trust facet over an unfiltered result set — was rejected because it would make the default view a matter of remembering to tick a box, and because a per-card marker on every record would assert a constant rather than carry information. The one genuinely non-obvious case, a record admitted through someone else's Binding, is explained where there is room for the sentence.
