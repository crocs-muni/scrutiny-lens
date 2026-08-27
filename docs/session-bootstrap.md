# SCRUTINY Lens — Session Bootstrap (handoff brief for fresh sessions)

> Purpose: a self-contained briefing so a *new* session (fresh context) can run the `grill-with-docs` skill on remaining decisions, then build. Read this FIRST, then `llms.txt`, then the spec docs it points to. Current state pinned at 2026-08-26.
> Owner conventions are in §5 — violations will be called out.

---

## 1. Project in one paragraph

SCRUTINY Lens is a desktop analyst tool for exploring Common Criteria security certificates and related security metadata, rendered as an interactive graph over the SCRUTINY Fabric protocol (a Nostr-based decentralized overlay; spec lives at `crocs-muni/scrutiny-fabric`, SDK at `crocs-muni/scrutiny-fabric-tools` = `@scrutiny-fabric/core`). The first version (AI-built, archived on branch `archive/session-explorer-v1`) was assessed as ~7/10 and **rebuild-won**: v2 is written spec-first, AI-interpretation-first (every event interpreted; tags are verification scaffolding), with an owned generative-UI pattern: LLM fills zod view-model schemas → deterministic registry maps VM→Svelte component; AI picks semantics never presentation.

## 2. Read order (after this file)

1. `llms.txt` — doc index
2. `docs/prd.md` — goals/non-goals/success criteria
3. `docs/architecture.md` — module map, invariants I1–I8, **ADR log 001–017** (decision register)
4. `docs/view-models.md` — the zod VM catalog (11 VMs + presentation contracts: citation color-pairing, card anatomy)
5. `docs/journeys.md` — J1–J5 with acceptance criteria
6. `docs/component-registry.md` · `docs/profiles.md` (CC-domain vocabulary appendix) · `docs/types.md` · `docs/api.md` · `docs/verification.md` · `docs/glossary.md`
7. Visual review artifacts: `docs/vm-gallery.html`, `docs/card-prototypes.html`, `docs/card-redesigns.html`, `docs/citation-palette-candidates.html`
8. `research/` — evidence files: stack challenges, genui protocols, card/citation/facet UX, design canon, pipeline notes, design board text

## 3. Decisions LOCKED (do not re-open without strong cause)

- **Rebuild** (not fix-forward), Svelte 5/SvelteKit 2, nostr-tools (NDK removed), @scrutiny-fabric/core for protocol, repo = overwrite `crocs-muni/scrutiny-lens` (old code on `archive/session-explorer-v1`).
- **Grill Q1–Q8 locked**: AI interprets every event; card = one interpreted graph (grouping key = found-event id); batch-tiered LLM economics; skeleton-now-AI-fills-later; profiles = prompt+facets only; provenance tracked internally, hidden from user; one small model all tasks (temp 0.2); cache key (entityId·schemaVersion·profile·model), no TTL, SQLite; honest degradation (never blocks, never lies, one repair-retry); eval thresholds locked (Parse 100% / Schema 100% / Value ≥95% / Quality ≥80%) with the **eval harness deferred to GitHub issue #2**.
- **Owner overrides 2026-08-24**: MULTI-RELAY in scope (pool 2–4 relays, per-relay status surfaced); NO fixture/demo data — relay unreachable → error state only; VM-level provenance envelope (not per-field); summaries (`interpreted` source) exempt from verbatim gate; AI-origin wording must never appear in public-facing names.
- **Stack challenge verdicts (ADR-014–017)**: ai SDK **v7** pinned; chat render hybrid `svelte-streamdown` + component-mapped citations; persistence **`node:sqlite` day one** (ADR-015 — zero native deps, swap back to better-sqlite3 = 4–8h); test = vitest 4.1 + fast-check.
- **GenUI protocols**: own zod-VM→registry pipeline stays; **borrow** A2UI-shaped SSE envelope *after* tracer bullet (deferred, not rejected).
- **FacetSetVM**: dynamic packs (base 4 + query-shaped + profile overlay), publishers tri-state (include/exclude/any) with human names, two labeled date domains (Published to fabric vs Certified), OR-within/AND-across, applied-filter chips, ≤8 options then "Show more".
- **ChatMessageVM**: 3-state citation support (`verbatim`/`partial`/`extrapolatory`, computed-vs-assessed visually distinct); streaming `pending`→`resolved`; claimsSummary strip; markdown-footnote export; **color pairing** (palette below).
- **Citation palette (locked)**: `['#6366f1','#8b5cf6','#ec4899','#06b6d4','#94a3b8','#6b7280']` — soft neutrals, excludes all app semantic hues; wavy underline as mandatory dual-code; registry assigns color from n deterministically, never the model.
- **CardVM**: `match` = internal sort key ONLY (never displayed); display = `matchBand` (deterministic band rule) + `matchReasons` ≤3 (computed, validated); `snippet` = `{text ≤300, highlights[] ≤2 spans}` under R1–R8 rules + deterministic validator; `metaSegments[]` server-composed with silent omission; card↔detail verbatim-superset contract; title ≤120 + ellipsis.
- **Environment**: `PUBLIC_RELAY_URLS` (comma-separated 2–4), `API_KEY`, `BASE_URL`, `MODEL`.
- **AI service (ADR-018)**: endpoint registry (named OpenAI-compatible configs: env default + user override/OpenRouter preset); user keys browser-held, never persisted/logged server-side; **no quota machinery** in v2 — public instances must run no-env-key BYOK mode or accept cost risk.

## 4. Open threads (what the new session should drive)

| # | Open item | State | Where to start |
|---|---|---|---|
| 1 | **Card layout choice** | UNDECIDED — owned by the **UI-library session**; prototypes at `docs/card-prototypes.html` (+ `docs/card-redesigns.html` alternatives) are their material | NOT a backend dependency — backend ships `CardVM.content` regardless |
| 2 | Deep-dive reviews not yet run | InterpretingVM · NodeDetailVM · 4 NodeVMs · ResultGroupVM · StateVM trio · SessionListItemVM | Run in backend lulls or after W4, one grill loop each (chat/facet/card pattern established) |
| 3 | Verification checks C1–C3 | Open: ai SDK v7 streaming API exact surface · nostr-tools current SimplePool/AbstractRelay API · small-model array-output reliability on e-infra at temp 0.2 | ~30–60 min; gate for build waves W3/W4 |
| 4 | **W0 scaffold (tracer bullet)** | Env/config, tsconfig strict, node:sqlite repo open, `/api/ai/health` returns model | W0→W6 wave plan in `docs/architecture.md` module detail + build order discussion |
| 5 | Spec checkpoint | Everything uncommitted on `main` — commit first: branch `spec/phase-0`, plain `git commit -m`, no push, no sign-off | Owner action |
| 6 | Deferred scope (GitHub issues) | #2 eval harness · #3 live subscriptions · #5 user-authored events · #6 graph diffs · #7 contributor docs | Parked; revisit post-MVP |

## 5. Working rules the owner holds (mandatory)

1. **Choices at every fork**: present 2–4 options with consequences + one recommendation (ask-tool style); the owner picks.
2. **No silent defaults**: judgment calls queue to the owner; mechanical/typo fixes are fine autonomously.
3. **Grilling style**: one question at a time, wait for the answer; facts get looked up (tools), decisions belong to the owner.
4. **Evidence discipline**: research claims come from primary sources with URLs; `_assumption` label for unverified; review claims get cross-checked before landing.
5. **Subagents**: ≤3 concurrently; researchers return file:line evidence; verify their claims before applying.
6. **As-docs discipline**: ADRs → §ADR log in `docs/architecture.md` (next free number; currently 001–017); new vocabulary → `docs/glossary.md`; spec fields only change in `docs/view-models.md`.
7. **Conventions**: conventional commits without sign-offs; protocol terms from `docs/glossary.md`; kebab-case `t` tags (TAG-4); no `@nostr-dev-kit/ndk` anywhere.

## 6. Session split (owner decision 2026-08-26): backend first, UI-library in parallel

The work is split across two sessions. The owner runs the UI component library in ANOTHER session; this (or a fresh backend) session owns the server-side foundation.

| Session | Owns | Contract seam |
|---|---|---|
| **Backend (spec → build)** | W0–W6 waves: scaffold → transport (nostr-tools) → fabric seam (@scrutiny-fabric/core) → pipeline (output/verifier/cache/projector) → agents → routes → Docker | `docs/view-models.md` (VM schemas), `docs/api.md` (route envelopes), `docs/verification.md` (DDL + contracts), `docs/profiles.md` (CC vocab) |
| **UI library** (other session) | Svelte components rendering the VMs; card layout decision (prototypes at `docs/card-prototypes.html` + `docs/card-redesigns.html` are THEIRS to judge); tokens, registry, gallery | same two spec files + gallery pages |

The card-layout pick is **not** a backend blocker: the backend fills `CardVM.content`; how a component renders the content is the library session's decision. Sequencing rule for this session: backend waves first; component-side deep-dive reviews (InterpretingVM, NodeDetailVM, NodeVMs, ResultGroupVM, StateVM, SessionListItemVM) happen in lulls or after W4.

**Suggested first moves for the backend session:**
1. `git status` → owner-run commit to `spec/phase-0` (§4.5) as the checkpoint.
2. Skip the spec-deep-dive loop; start C-checks folded into the waves they unblock: C2 (nostr-tools SimplePool/AbstractRelay surface + relay.count) inside **W1**; C3 (small-model array structured output on e-infra at temp 0.2) inside **W3**; C1 (ai SDK v7 streaming API with `Output.object|array`) inside **W3/W5**. No standalone research days.
3. **W0 scaffold**: SvelteKit + strict TS + `node:sqlite` repo layer open (ADR-015) + `GET /api/ai/health` returning `{ok, model}` + env contract validated with zod (`API_KEY`, `BASE_URL`, `MODEL`, `PUBLIC_RELAY_URLS`).
4. **W1 transport**: relay pool 2–4 (`PUBLIC_RELAY_URLS`), fan-out+dedupe, timeouts (5/8/3s), per-relay status for RelayErrorStateVM.
5. **W2 fabric seam**: validate/resolve via core + injected hash; **W3 pipeline core** (output.ts zod-gate + 1 repair-retry + degrade, cache, verifier); **W4 query+cards**; **W5 nodes+chat SSE**; **W6 detail + relay-error + projector fallback + Docker**.
6. Parked-but-watch-national: A2UI-shaped SSE envelope deferred (§3); multi-relay conflict = dedupe by event id only for v2.

## 7. Repo facts

- Root: `C:\Users\alsorehi\scrutiny-lens` · branches: `main` (current) + `archive/session-explorer-v1` (v1 safety copy).
- Related repos (same machine): `scrutiny-fabric` (protocol spec + vectors, public), `scrutiny-fabric-tools` (TS SDK monorepo → `@scrutiny-fabric/core`; package is spec'd for public npm later, currently file: dep).
- LLM endpoint: e-infra OpenAI-compatible (`BASE_URL=https://llm.ai.e-infra.cz/v1`, `API_KEY`, `MODEL`; user said models to prefer: gemma4 / qwen3.5-27b / deepseek-v4-flash).
- Design source of truth for UI intent: `research/design-board-text.md` (extracted from the owner's claude.ai design export; 1-month stale — confirmed acceptable).
