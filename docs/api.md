# SCRUTINY Lens — API Contracts

> Status: **Draft** · Cross-references: [architecture.md](architecture.md) · [view-models.md](view-models.md)
> All endpoints are SvelteKit `+server.ts` routes under `/api/`. Every request body is zod-parsed at the route boundary (fixes v1 finding: ChatRequest schema never parsed at routes).

---

## Conventions

| Rule | Detail |
|---|---|
| Request validation | zod `.safeParse` on every POST body; 400 `{ error: 'invalid_request', issues }` on failure |
| Agent errors | All agents return `AIResult<T>` = `{ ok: true, result: T }` or `{ ok: false, kind, message }`; routes map kind → HTTP status |
| Degradation | LLM unreachable → agent returns `{ ok: false, kind: 'no-key' | 'unreachable', message }`; route responds 503 with `Retry-After: 30`; UI falls back to deterministic projection (Q3 grill) |
| Timeout | 30s per agent call server-side; abort signal propagated from client disconnect |
| Streaming | `/api/chat` streams via SSE (real streaming — fixes v1 fake-streaming finding) |
| Provider selection | Every agent route accepts optional `provider: { name?, baseUrl, model, apiKey }` (browser-held BYOK, ADR-018). Validated with zod; server instantiates the named OpenAI-compatible endpoint for that request only; keys are **never persisted nor logged** (exist only during request lifecycle). Default = env config. |
| Public-hosting warning | If the built app is exposed publicly **with an env API_KEY**, `/api/ai/*` is an open quota drain for your key. Either deploy private, or require BYOK (no-env-key mode) on public instances (hosting mode is a deployment flag; quota machinery intentionally absent in v2, ADR-018). |

### Error envelope

```json
{ "error": "no_key" | "unreachable" | "invalid_request" | "schema_failure" | "timeout" | "relay_error", "message": "human-readable", "retryable": true }
```

---

## POST /api/ai/query

Query agent: free-text query → interpretation + relay filters.

**Request:**
```json
{ "query": "ROCA vulnerability in Infineon chips", "profile": "smartcard" }
```

**Response 200:**
```json
{
  "interpretation": "Recognized ROCA as cve:CVE-2017-15361 …",
  "steps": [{ "kind": "recognized", "label": "Recognized ROCA as cve:CVE-2017-15361", "prefix": "cve", "value": "CVE-2017-15361" }],
  "filters": [
    { "mode": "identifier", "identifier": "cve:CVE-2017-15361" }
  ]
  // transport applies defaults kinds:[1], limit:50 — docs/verification.md
}
```

Errors: 400 invalid_request · 503 no_key/unreachable

---

## POST /api/ai/cards

Card agent (batched): graphs + query → one `CardVM` per graph. One call per results page.

**Request:**
```json
{
  "graphs": [{ "entityId": "…", "event": { /* NostrEvent */ }, "neighbors": [{ /* NostrEvent */ }] }],
  "query": "ROCA vulnerability in Infineon chips",
  "profile": "smartcard"
}
```

**Response 200:**
```json
{
  "cards": [ /* CardVM[] — same order as request graphs, with provenance envelope */ ]
}
```

Schema gate: each CardVM validated against `CardVMSchema`; failures get 1 repair-retry (zod error appended); still-failing entries returned with `provenance.origin: 'partial'` + degradedFields.

Errors: 400 · 503

---

## POST /api/ai/nodes

Node agent (batched): visible events → `NodeVM[]`. Called on session open and on expand (new visible nodes only).

**Request:**
```json
{
  "events": [{ /* NostrEvent */ }],
  "graphContext": { "rootSummary": "Infineon M7794 · ROCA exposure", "query": "ROCA…" },
  "profile": "smartcard"
}
```

**Response 200:** `{ "nodes": [ /* NodeVM[] */ ] }`

Errors: 400 · 503

---

## POST /api/ai/detail

Detail agent: single event, full content → `NodeDetailVM`.

**Request:**
```json
{ "event": { /* NostrEvent */ }, "patchEvents": [{ /* NostrEvent */ }], "profile": "smartcard" }
```

**Response 200:** `{ "detail": /* NodeDetailVM */ }`

Errors: 400 · 503

---

## POST /api/chat

Chat agent: question + visible graph → streaming answer with citations. **Real streaming via SSE** (fixes v1 finding: client awaited `res.text()` fully).

**Request:**
```json
{
  "question": "Which products are affected by ROCA?",
  "history": [{ "role": "user", "content": "…" }],
  "events": [{ /* NostrEvent — visible nodes only */ }],
  "rootSummary": "Infineon M7794 · ROCA exposure"
}
```

**Response 200** (SSE stream):
```
event: delta
data: {"text": "All three Infineon parts"}

event: delta
data: {"text": " on this graph — …"}

event: final
data: {"citations": [{"n": 1, "eventId": "…", "quote": "…"}], "followUps": ["…"]}
```

Timeout: stream aborts on 30s server timeout; partial content preserved; `event: error` emitted before close (fixes v1 finding: dead abortSignal/timer).

Errors: 400 · 503 (pre-stream only; mid-stream failures via SSE `event: error`)

---

## POST /api/ai/followups

Followups agent: conversation context → suggested questions.

**Request:**
```json
{ "question": "…", "answer": "…", "rootSummary": "…" }
```

**Response 200:** `{ "followUps": ["Show the maintenance update diff", "Compare EAL levels", "Which are archived?"] }` (max 3)

Errors: 400 · 503

---

## GET /api/ai/health

Health check for LLM endpoint + required env.

**Response 200:** `{ "ok": true, "model": "gemma4", "endpoint": "https://llm.ai.e-infra.cz/v1" }`
**Response 503:** `{ "ok": false, "reason": "no_key" | "unreachable" }`

Used by UI to pre-emptively show degraded-mode notice.
