# SCRUTINY Lens — Product Requirements (PRD)

> Status: **Draft** · Version: 0.1.0 · Audience: build agents, project founder
> Content in this file is locked before implementation begins. Changes go through edit-review.

---

## 1. What SCRUTINY Lens is

A desktop analyst tool for exploring Common Criteria security certificates and related security metadata as an interactive graph, powered by [SCRUTINY Fabric](https://github.com/crocs-muni/scrutiny-fabric) (a Nostr-based decentralized metadata overlay protocol).

An analyst types a plain-English query ("ROCA vulnerability in Infineon chips"). The app interprets the query, fetches matching events from Nostr relays, groups them into per-product graphs, and renders an interactive session canvas with:

- **AI-interpreted cards** — each card summarises one product-graph (title, match rationale, snippet, stats)
- **Interactive graph canvas** — nodes are interpreted events (products, CVEs, reports); edges are protocol bindings
- **Grounded chat** — an AI assistant that answers strictly from the on-screen nodes and cites its sources
- **Patch history** — git-style diffs attached to nodes, showing content evolution
- **Audit mode** — retracted/deleted nodes visible for forensic review

---

## 2. Who it's for

**Security analysts** investigating certified hardware/software (smart cards, TPMs, secure elements, biometric sensors, network equipment). A typical session: "Which products are affected by CVE-2017-15361, and which of those are still actively certified?"

**Niche profiles** — the app supports analyst profiles that tune the interpretation lens (see [profiles.md](profiles.md)):

| Profile | Focus | Emphasis |
|---|---|---|
| `smartcard` | Smart cards, secure elements, TPMs | EAL levels, chip families, crypto side-channels, schemes (BSI, ANSSI, NIAP) |
| `certificate` | Common Criteria certificates | Validity dates, maintenance history, assurance continuity, scheme-to-scheme comparison |
| `generic` | Any security-relevant product | Broad metadata coverage, vendor/product discovery |

Profiles are config-driven; the underlying VM schemas are profile-agnostic.

---

## 3. Goals

1. **Interpretation is the product.** Every event is interpreted by AI (never passed raw). Structured tags are verification scaffolding, not the primary source.
2. **Never lie.** AI-filled fields are quote-verified against source content; degraded interpretations are labeled, not hidden.
3. **Responsive.** Deterministic skeleton renders immediately; AI fields stream in progressively.
4. **Graph-native.** All display units are graphs — a card is a mini-graph, the session canvas is an expanded graph. Edges come from protocol bindings (deterministic), not AI inference.
5. **Open source & agent-buildable.** Spec docs, mermaid diagrams, AGENTS.md, llms.txt — buildable by AI agents from the spec alone.
6. **Multi-relay-aware.** Fetch fans out across 2-4 configured relays; per-relay health (ok/timeout/refused) is surfaced, never hidden.

---

## 4. Non-goals (scope boundary)

| Area | Status | Why deferred |
|---|---|---|
| Real-time relay subscriptions (live-push session updates) | Deferred → GitHub issue | WebSocket lifecycle complexity; design board shows polling/sync, not push |
| Multi-relay aggregation & conflict resolution | **In scope** (owner override 2026-08-23) | Relay pool 2–4 + per-relay status UI |
| User-authored events (publishing annotations) | Deferred → GitHub issue | Read-only analyst tool for now |
| Graph diffing/exporting | Deferred → GitHub issue | Power-user feature, not core journaled path |
| Eval harness (golden datasets, LLM-judge gates) | Deferred → GitHub issue | Provenance/verification design provides inline guardrails |
| Contributor docs (how to add VM/icon/profile) | Deferred → GitHub issue | Written after first VM is built, not spec'd upfront |

---

## 5. Success criteria

A build agent can implement SCRUTINY Lens from these spec docs alone, and the result:

- Passes deterministic contract gates: **Parse 100%** (after 1 repair retry), **Schema 100%**, **Value ≥95%** fields verified, **Quality ≥80%** (LLM-judge)
- Handles an LLM outage gracefully (deterministic skeleton + "uninterpreted" labels)
- Renders all design board screens: A (search), A′ (interpreting), B (results), C (session+chat), D (detail+audit), E (empty/error/ungrounded states)
- Consumes `@scrutiny-fabric/core` for all protocol operations (validation, resolution, admission)
- Uses `nostr-tools` for relay transport (no NDK dependency)
- Svelte 5 + SvelteKit 2, Tailwind 4, `@xyflow/svelte` graph
- Docker Compose bundle: `docker compose up --build` → working app at `http://localhost:5173`

---

## 6. Architecture one-liner

> **AI chooses semantics, never presentation.** The model fills closed schemas with validated values; all visual decisions are deterministic functions of tokens the model picks from enums.

See [architecture.md](architecture.md) for the full module diagram and data flow.
