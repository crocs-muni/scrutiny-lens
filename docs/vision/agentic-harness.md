# An agentic harness for the lens

The idea is a chat-driven agent over the corpus: it searches, opens events, resolves patch
chains, follows bindings, and shows what it found. It is read-only, so nothing it displays
can have been authored by it; it talks only to the configured relays and the reader's own
model endpoint. This is a sketch, not a plan: written down so the shape survives.

## Three questions, one pipeline

- **A comparison.** "Which cards up to a given version sign ECDSA fastest?" A matrix whose cells
  come from record cards and canonicalised metrics, each tied to its span. The answer has no
  subject topology, so the trust tile is absent: a layout that can leave a slot empty is the point.
- **A cohort.** "Which cards are affected by ROCA?" A tag cohort, a route from the author's
  wording to canonical prefix values, and each card's supporting evidence beside it.
- **A subject.** "Everything about one card." A dossier: patch history with held states rendered
  honestly, bindings with provenance, and a graph explorable as the turns that built it.

All three run through one generic pipeline. A change that only helps one of them is in the
wrong place; they are tests of the same spine, not three features.

## A skeleton with conditional slots

Answers sit in a layout that does not move. Code decides which slots exist, from the shape of
the result, and where each one sits. The model chooses which references fill a slot, their
order inside it, and writes one hedged framing line. A layout that rearranges every turn costs
the reader their bearings while structure earns its keep; a model owning slot existence could
reshape the page at will, and code owning references would be guessing at meaning it cannot read.

What the model may never decide: whether a count or a status is true, or whether a quote is
real. Those come from the evidence column, which runs beside the transcript and stays aligned
with the chat citations.

## The orchestrator decides

A deterministic orchestrator runs the loop, capped at a handful of automatic steps, with a step
log the reader can open. Recall comes before ranking: every applicable probe runs — direct
identifier lookups, cohort tags, short rare-term text probes, identifiers mined from the first
round — and everything returned is verified before display. A deterministic conductor exists
because a small model drifts over a multi-step plan, and a stop rule that changes with the model
makes one question produce different work on different days. The step log also gives an answer a
scope, which is what lets a completeness stamp ("complete as of relay R at T") be a claim the
client can defend instead of a number a relay volunteered.

## Derived values

Expiry dates, version bounds, identifiers, canonicalised benchmark metrics: parsed
deterministically from record cards on mirrored events, held in a cache keyed by event id, linked
to its span, and marked derived. The cache is recomputable, so a re-fetch yields the same answer,
and every "newest" or "fastest" question reads it instead of re-deciding. A model that can invent
a string is a liability in a surface that promises not to lie, and the corpus is templated enough
that a parser gets everything it needs.

## Evidence

Citations are verified against resolved canonical content, not the raw event. A quote matching
only an earlier version never supports a present claim; it is shown, labelled as history, with
the patch that replaced it. Verifying against raw content would let replaced text count as
current support — the never-lie rule defeated by its own gate.

## Export and replay

A session downloads as markdown for people and JSON for machines: questions, step log, event
references, checkpoint ids, relay stamps. Opening one re-fetches the referenced events from the
reader's relays and recomputes the deterministic claims, marking each re-verified or stale. A
shareable link would need hosted state, and publishing a transcript as an event cannot be
revoked; a file handed to a chosen recipient keeps sharing deliberate, and recomputation makes
the artifact checkable rather than a screenshot.

## The path with no key

Without a key the app still searches, derives, verifies, draws the graph and exports; what it
loses is prose. With a key, the model writes the framing line, the chat answer over the
top-ranked verified passages, summaries and titles, and may propose search terms the orchestrator
re-runs through the same probes. It never plans steps and never calls tools, so chat with a key is
chat without a key plus prose — the same loop, the same log, the same determinism — and the
failure mode of a model that plans badly is removed rather than mitigated. A model failure falls
back to the event's own tags and the first stretch of its content, marked raw, never to an empty
state.

## Invariants it must keep

Already written down elsewhere; this points at them rather than restating them.

- Static SPA, no application server, no telemetry, every asset self-hosted.
- Never lie: status, counts, patch history, facets, dates and quotes are computed, never written;
  a quote matches verbatim or the claim is dropped. See `docs/spec.md` §2.
- The endpoint key stays in the tab's session storage, never in IndexedDB, never logged. See `docs/spec.md` §6.
- All protocol work through the SDK; a gap is filed and worked around minimally.
- Build rules, from runes to tag spelling, live in `AGENTS.md`.
