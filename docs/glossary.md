# SCRUTINY Lens — Glossary

> Status: **Draft** · Vocabulary aligned to SCRUTINY Fabric protocol spec v0.8.0 (`crocs-muni/scrutiny-fabric`, docs/protocol-spec.md). Section refs point into that spec.

## Protocol entities (four event types, all kind:1)
- **Product** (`t: scrutiny-product`) — security-relevant target; identity = event id. §4.1
- **Metadata** (`t: scrutiny-metadata`) — observation/about-a-product (report, SBOM, CVE description, advisory). §4.2
- **Binding** (`t: scrutiny-binding`) — signed directed edge Metadata → Product; never a node. Two `e` tags: marker `root` = product, marker `link` = metadata. §4.3
- **Patch** (`t: scrutiny-patch`) — git-style diff against a target's content, inside a CommonMark §4.5 fence. §4.4

## Indexers & tags
- **`i` tag** — canonical indexer per NIP-73 `<prefix>:<value>`; enables `#i` relay filtering. Prefixes we recognize: `cc` (certificate), `cve`, `cwe`, `cpe`, `vendor`, `pp` (Protection Profile).
- **`k` tag** — declares which indexer prefix *kinds* are present (set semantics). §4.1/§9
- **`t` tags** — required: `scrutiny-fabric`, version `scrutiny-vM.m.p`, exactly one event-type tag. Kebab-case only (TAG-4).
- **`imeta`** — NIP-92 attachment (report PDFs etc.).
- **`e` tag markers** — `root` / `link` on bindings (NIP-10).

## Identity & lifecycle
- **kind 5 (deletion)** — NIP-09 event retracting author's own events by id; NOT an erasure of others' events; no undo ("retraction has no reversal" — restoring means publishing a fresh event). §10
- **Orphaned annotation** — event whose reply-target was deleted; held in audit (α/β degradation), hidden by default.
- **`created_at`** — event creation time, NOT the fact date (CA-1: don't backdate; historical dates live in content).

## App vocabulary
- **Session** — a saved investigation: root event + graph state + chat history, persisted in SQLite.
- **Found event** — the event a relay filter matched; the grouping key for result graphs (ADR-004).
- **1-hop neighborhood** — found event + everything bound to it in either direction.
- **Hop depth** — J2 control; level-k expansion of neighbors from the root.
- **CardVM / NodeVM / …** — view-models produced by AI interpretation over entities/graphs (see view-models.md).
- **Provenance envelope** — internal metadata tracking origin/degraded fields per VM; never rendered (I8).
- **Degradation projections** — `degraded[]` / `notVerbatim[]` derived into content for honest-failure rendering (I5).
