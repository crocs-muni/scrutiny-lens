# Citations are verified-or-inert; chat history is a record

A chat citation whose quote fails verbatim verification is dropped silently: no pill, no underline, no flag. The claim sentence it sat beside stays in the answer as plain unsourced AI prose — an inert claim. Chat answers are one of the AI-written surfaces spec §2 rule 1 permits, so unsourced prose inside them is honest as long as nothing marks it as verified; what must never render is the trust signal itself.

Rejected: excising the whole claim sentence (the strictest reading of "the claim is dropped") — sentence surgery on streamed prose produces broken text, and no precedent excises post-hoc (Elicit-style abstention happens before writing, which parse time cannot do). Rejected: a visible "unverified" flag (Scite-style) — issue #30's acceptance says failed citations are "dropped silently, never rendered", and a permanent distrust badge contradicts the trust surface the feature sells.

History is a record. Chat messages persist with their citations resolved as of answer time — pinned numbers, verified quote spans, color pairing. Loading a session never re-verifies: a later retraction or patch arriving must not silently change what an answer said (history that shifts under you is its own lie). Pending shimmer pills and aborted streams persist nothing — only settled final frames land in the store.

Consequences: `claimsSummary` counts drops so conformance tests can assert zero unverified pills in rendered output; citation numbers (and their color pairing) are pinned per conversation and persist with the session, so "report 2" means the same event for the whole chat and its reloads.

Owner-ruled 2026-09-14 during #30 planning.
