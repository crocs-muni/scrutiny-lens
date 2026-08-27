# SCRUTINY Lens — Domain Profiles

> Status: **Draft** · Cross-references: [prd.md](prd.md) · [view-models.md](view-models.md) · [component-registry.md](component-registry.md)
> Profiles are configuration, not code. One VM schema; profile selects lens (prompt + facets + vocab).

---

## 1. Profile schema

```ts
interface DomainProfile {
  /** Profile key used in prompts and cache */
  key: string;
  /** Display name */
  name: string;
  /** Description (for UI tooltip) */
  description: string;

  /** Which facets to show in the filter sidebar */
  facets: FacetConfig[];

  /** Which t-tags to recognize as indexer prefixes */
  /** Known indexer prefixes this profile recognizes */
  recognizedPrefixes: string[];

  /** System prompt appendix — sets the analyst lens */
  systemPrompt: string;

}

interface FacetConfig {
  /** Facet key (used in filter state) */
  key: string;
  /** Display label */
  label: string;
  /** Selection mode */
  mode: 'single' | 'multi';
}
```

---

## 2. Built-in profiles

**Shared CC-vocab appendix** — prepended verbatim to EVERY agent prompt (profiles add only their lens delta). Canonical corpus vocabulary:

- Scheme names: `BSI` (Germany), `ANSSI` (France), `NIAP` (USA). NIAP certs show Protection-Profile conformance, NOT EAL levels (NIAP has not assigned EALs since ~2014).
- Certificate-ID formats: `BSI-DSZ-CC-\d{4}-\d{4}` and `ANSSI-CC-\d{4}/\d{2}`.
- Assurance strings match `^EAL[1-7]\+?$` (`EAL4+` = "EAL4 augmented", not a level).
- Canonical category strings from the CC portal, e.g. `ICs, Smart Cards and Smart Card-Related Devices and Systems`.
- Indexer prefixes: `cc`, `cve`, `cwe`, `cpe`, `vendor`, `pp` (Protection Profile).
- Lifecycle: `Active` / `Archived`; scheme withdrawal maps to `archived`. `Maintenance` is a metadata kind, never a status.

### `smartcard`

```json
{
  "key": "smartcard",
  "name": "Smart Cards",
  "description": "Focus on smartcard ICs, secure elements, TPMs — with emphasis on EAL levels, chip families, and crypto side-channels.",

  "facets": [
    { "key": "scheme", "label": "Scheme", "mode": "multi" },
    { "key": "assurance", "label": "EAL Level", "mode": "multi" },
    { "key": "status", "label": "Status", "mode": "multi" },
    { "key": "vendor", "label": "Vendor", "mode": "multi" }
  ],

  "recognizedPrefixes": ["cpe", "cve", "cc", "cwe", "vendor", "pp"],

  "systemPrompt": "Lens: smartcard/secure-element analyst. Emphasize chip family, interface (contact/contactless), crypto library, side-channel vectors (ROCA, power analysis, timing), certified platform version, and maintenance path."
}
```

### `certificate`

```json
{
  "key": "certificate",
  "name": "Certificates",
  "description": "Focus on Common Criteria certificates — validity, maintenance history, assurance continuity, cross-scheme comparison.",

  "facets": [
    { "key": "scheme", "label": "Scheme", "mode": "multi" },
    { "key": "assurance", "label": "EAL Level", "mode": "multi" },
    { "key": "status", "label": "Status", "mode": "multi" },
    { "key": "category", "label": "Category", "mode": "multi" }
  ],

  "recognizedPrefixes": ["cc", "cve", "cpe", "cwe", "vendor", "pp"],

  "systemPrompt": "Lens: CC-certificate analyst. Emphasize validity dates, assurance continuity (maintenance reports), re-certification history, and cross-scheme comparison. Note maintained-vs-reissued and gaps in assurance."
}
```

### `generic`

```json
{
  "key": "generic",
  "name": "Security Products",
  "description": "Broad coverage of any security-relevant product — software, hardware, network devices.",

  "facets": [
    { "key": "category", "label": "Category", "mode": "multi" },
    { "key": "vendor", "label": "Vendor", "mode": "multi" },
    { "key": "status", "label": "Status", "mode": "multi" }
  ],

  "recognizedPrefixes": ["cpe", "cve", "cc", "vendor", "cwe", "pp"],

  "systemPrompt": "Lens: general security-product analyst. Coverage-oriented; emphasize product type, vendor, and associated vulnerabilities."
}
```

---

## 3. How profiles affect the pipeline

```mermaid
flowchart TD
    PROFILE[DomainProfile selected<br/>(or auto-detected)] --> A
    subgraph "Search (J1)"
        A[Query agent system prompt] -->|+ profile.systemPrompt| QA
    end
    subgraph "Results (J1)"
        FACETS[FacetSetVM config] -->|profile.facets| FV
        CARDS[Card agent system prompt] -->|+ profile.systemPrompt| CA
    end
    subgraph "Graph (J2)"
        NODES[Node agent system prompt] -->|+ profile.systemPrompt| NA
    end
    subgraph "Detail (J4)"
        DETAIL[Detail agent system prompt] -->|+ profile.systemPrompt| DA
    end
```

**Rules:**
- Profiles do NOT change VM schemas — one CardVM/NodeVM/etc. for all profiles
- Profile `systemPrompt` is **appended** to each agent's base prompt (not replacing it)
- Profile `facets` config = **overlay**: its entries merge beneath the query-selected pack (base top, pack middle, overlay bottom); duplicates merge — never render twice (see view-models.md §3.4)
- Profile `recognizedPrefixes` constrains the query agent's filter generation (unknown prefixes rejected)
- Profile selection: manual dropdown in UI (persists per session), auto-detect from query keywords on first visit

---

## 4. Adding a new profile

1. Create `src/lib/profiles/<key>.ts` implementing `DomainProfile`
2. Register in `src/lib/profiles/index.ts`
3. No new VM schemas, no new components, no new agents needed
4. Eval: run contract gates with `PROFILE=<key> pnpm test` — profile is a test dimension, not a schema fork
