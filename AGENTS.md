# AGENTS.md — Build rules for AI agents

Read this before writing code. Violations of these rules are build-breaking.

## Spec authority order

1. `docs/prd.md` — goals, non-goals, success criteria
2. `docs/journeys.md` — user journeys with acceptance criteria
3. `docs/view-models.md` — zod schemas; the ONLY source of VM field truth
4. `docs/architecture.md` — module map, invariants, ADRs
5. `docs/component-registry.md` — VM→component mapping, icon taxonomy
6. `docs/profiles.md` — domain profiles (prompt + facets + vocab config)
7. `docs/api.md` — route contracts
8. `docs/types.md` — shared types (NostrEvent, GraphView, Session, SearchFilter, Citation, ChatTurn, VM aliases)
9. `docs/verification.md` — fixture/sskeleton→fill/Docker/citation-registry/vm_cache/empty-first-run contracts
10. Protocol: `@scrutiny-fabric/core` + `docs/glossary.md` vocabulary

If code and spec disagree, spec wins. Change the spec via PR edit, never silently.

## Hard rules

- **Svelte 5 runes only.** `$state`, `$derived`, `$effect`, `$props()`. No legacy `export let`, no stores API for cross-component state.
- **All `i`/`k` tag constants and protocol shapes come from `@scrutiny-fabric/core`** — never hand-rolled.
- **API_KEY never leaves the server.** `$env/dynamic/private` only. **User-supplied API keys are never persisted nor logged server-side** — they exist only inside request lifecycle (ADR-018). Public relay pool env is `PUBLIC_RELAY_URLS` (comma-separated 2–4).
- **Every `{@html}` path sanitizes via DOMPurify** and every interpolated attribute escapes via the shared `escapeAttr`.
- **Every POST body zod-parsed at the route boundary** before any agent logic.
- **Real streaming** for chat (SSE `text/event-stream`); abortSignal threaded from client disconnect to LLM call; timeout clears only after stream close.
- **AI never picks icons/colors/layout.** Model picks `IconToken`/`TypeToken` from closed enums; `ICON_MAP`/registry maps to visuals.
- **Component registry is the only place `vm.kind` selects a component.** No `if kind ===` outside the registry.
- **Components never see the provenance envelope** — props are `vm.content` fields only.
- **Degradation is honest**: LLM down → deterministic skeleton + `uninterpreted` label; unverified quote → `not-verbatim` mark; never silently fabricate.
- **Edges come from the protocol resolver only** (`core.resolve`/`admit`), never from AI inference.
- **nostr-tools for all relay I/O.** No `@nostr-dev-kit/ndk` imports anywhere (forbidden; CI greps).
- **Updates flow through core's patch gate** — no direct application of `jsdiff`/`git apply` to patch payloads (determinism rule PB-1/PB-2; D32-style reasoning in core README).
- **kebab-case t tags only** (`scrutiny-product`, never `scrutiny_product`) — TAG-4.

## Conventions

- pnpm; `pnpm check` must be 0 errors; `pnpm test` per-module specs required for every shared lib module.
- Comments explain **why**, not what; cite spec rule ids (e.g., `// SIG-1`) where applicable.
- Conventional commits (`feat:`, `fix:`, `docs:`, …). No sign-offs, no Co-Authored-By.
- Env contract: `API_KEY` (required), `BASE_URL`, `MODEL`, `PUBLIC_RELAY_URL` — see `.env.example`.

## For LLM/doc agents

`llms.txt` indexes the docs. When consuming spec docs, read `docs/view-models.md` schemas as zod source of truth; examples in each VM section are canonical expected outputs.
