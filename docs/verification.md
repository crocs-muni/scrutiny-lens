# SCRUTINY Lens — Verification & Ops Contracts

> Status: **Draft** · Cross-references: [architecture.md](architecture.md) · [journeys.md](journeys.md)
> Slim contracts for the unglamorous pieces the spec needs to be buildable. (Eval harness itself is deferred — GitHub issue #2.)

---

## 1. No-fixture rule (owner decision 2026-08-23)

The app never fabricates demo data. No static fixture file. If the relay pool is unreachable or returns nothing, the UI shows the relay-error state (per-relay status, retry, continue-anyway). Data comes from relays only; the demo story relies on the real `scrutiny-relay-demo` relay running.

## 2. Docker contract

- `Dockerfile`: multi-stage pnpm build (frozen lockfile), `PUBLIC_RELAY_URLS` (comma-separated, 2–4 relays) as build-time ARG (inlined by adapter-node), `pnpm prune --prod`, runtime `node build`, `USER node`.
- `docker-compose.yml`: `explorer` (5173:3000) depends_on `relay` (healthy, 8080:8080); env pass-through `API_KEY` (required), `BASE_URL`=`https://llm.ai.e-infra.cz/v1`, `MODEL` default.
- **Runtime needs**: LLM endpoint reachable (else degraded mode); relay reachable (else fixture mode); `@scrutiny-fabric/core` from npm at `pnpm install` (file: dep during dev until published v0.1.0).
- Success: `docker compose up --build` → app at `http://localhost:5173` (PRD §5).

## 3. Skeleton → fill contract (ADR-006)

- **Skeleton**: cards render immediately as partial CardVM content — `title`, `identifiers`, `stats`, `groupKey` from tags+resolver; `snippet`, `match`, `vendor`, `category`, `typeToken` absent; `degraded: []`.
- **Fill**: when a batch resolves, the store merges AI fields BY `entityId` key into the existing objects (reference-stable merge — the card element is NOT replaced, so no flicker/re-mount; Svelte keyed `{#each}` over `entityId` is mandatory).
- **Terminal state**: on LLM failure, skeletons mark `degraded: ['snippet','match',...]` and gain the "uninterpreted" badge (I5 contract) — never a spinner forever, never fabricated text.
- Same pattern for nodes (J2) keyed by event id.

## 4. Citation registry contract

- **Scope**: per open chat panel (per session); module `createCitationRegistry()` (v1 pattern kept).
- **Numbering**: monotonically increasing `n` per NEW `eventId`; re-citing an event reuses its original `n` (stable numbering across messages — J3 AC6).
- **Resolution**: `[N]` → `{ eventId, quote, verified }` for hover/click handlers; unresolvable markers render as plain text (view-models.md §3.6 degraded marker rule).
- **Verification**: `verifyQuote(eventContent, quote)` at render time; failures → `content.notVerbatim` includes the citation key.

## 5. vm_cache DDL

Driver: node's built-in `node:sqlite` (`DatabaseSync`), Node 24 LTS, zero native deps; swap path back to `better-sqlite3` documented in ADR-015. No migration framework — `PRAGMA user_version` + startup schema check suffices.

```sql
CREATE TABLE IF NOT EXISTS vm_cache (
  entityType TEXT NOT NULL,      -- 'card' | 'node' | 'detail' | 'query' | 'chat' | 'followups'
  entityId TEXT NOT NULL,        -- event id (nodes/detail) or found-event id (cards)
  schemaVersion TEXT NOT NULL,   -- e.g. 'cardvm/1.0'
  profile TEXT NOT NULL,
  model TEXT NOT NULL,
  vmJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (entityType, entityId, schemaVersion, profile, model)
);
```

Rejected-but-interesting candidates land in a separate `dead_letter` table (same key shape + `reason TEXT`) for future eval work (issue #2).

## 6. Empty-first-run contract

Fresh install, no sessions, no API key, no relay:
1. App opens the search landing (A) — always.
2. Missing `API_KEY` → banner "LLM unavailable — deterministic mode" (health check via `GET /api/ai/health`).
3. Missing relay → search accepted; submit leads to the relay-error state (§1). Never a fake graph.
4. No modal blocks usage. The landing Try-chips work without any configuration.
