# SCRUTINY Lens — Spec (v2, cycle 1)

> Single source of truth for the current build cycle. Supersedes the 16-doc set (removed from the tree; git history preserves them). Edit ritual: propose line change → owner vetoes or accepts → line changes. No side documents.
> Review panel 2026-08-29 (7 agents): applied findings; rejected items are listed in §12.

## 0. Vocabulary (the whole data model)

- **Event** — a signed Nostr kind-1 note carrying SCRUTINY t-tags. Four types: **product**, **metadata** (both graph *nodes*), **binding** (a *directed edge* product↔metadata, carrying a label), **patch** (an edit to a root event's content).
- **Patch chain** — a root author's ordered patches; the SDK's `resolve()` yields current content + states `resolved / halted / forked / aborted / absent`.
- **Retraction** — a NIP-09 kind-5 deletion by the same author; sets `retracted` on the target. Only as complete as what relays return.
- **Session** — one investigation: the question, the fetched event set, the resolved graph, interpretation state, chat.
- **Node** — a product or metadata event as displayed; a **card** represents one product (root event) with its bound metadata summary.

## 1. What it is

A public, static website. No app server, no login — no first-party telemetry, analytics, or beacons (the static host unavoidably sees page loads). Deployed on academic servers; any static host works.

Analyst asks in plain English ("ROCA vulnerability in Infineon chips") or drops an identifier (CVE, package URL, GHSA, cert id… → routed **directly** to a tag query, never through AI). The browser asks public Nostr relays for matching SCRUTINY events, verifies each (Schnorr signature + id recompute — a shim we own; the SDK deliberately ships no default verifier), builds the product graph via `@scrutiny-fabric/core` (`createStore`, `resolve`, `computeAdmission`), and AI writes the readable layer: search translation, card texts, node titles/summaries, chat answers with citations.

Works with zero setup. For AI features the user pastes their own API key; it lives in memory for the open tab only and is sent only to the user's chosen endpoint.

**Share:** a button copies `${origin}/event/${nevent}` where `nevent` is a NIP-19 bech32 `nevent1…` encoding the root event id **plus relay hints** — a standard, interoperable nostr blob (nostr-tools `nip19.neventEncode`/`decode`). One opaque blob, no query params; `/event/<nevent>` routing is our own convention (njump-style), not a nostr standard. Same shape later serves the SEO idea (`/event/nevent1…` pages). Opening it runs the full fetch for that root: the event, its patch chain (`#e`+`#t`), bindings, and kind-5 deletions (`deletionsFor`, polled — relays may omit them). All states (incl. retracted) are discovered by normal resolution. A recipient with different relays/trust sees the same canonical bytes but a possibly different overlay view.

## 2. Never lie (the trust rules)

1. AI writes: search translation, card texts, node titles/summaries, chat answers. Nothing else.
2. Protocol/deterministic code computes: status, patch history, facet sidebar, counts, citation quotes, any date-vs-today comparison (e.g. expiry/validity dates in any security metadata). AI never touches these. (Status values are protocol-driven: `active`, `retracted` via kind-5, plus chain states `halted/forked/aborted`; "archived" is NOT a protocol status and does not exist.)
3. Chat quotes must match verbatim (whitespace-normalized substring) in an on-screen event's content, else the claim is dropped.
4. AI output must pass its zod shape (schemas live in `src/lib/ai/shapes.ts`, the only copy; include length caps: titles ≤120, reasons ≤3, snippets ≤300). Failure → retry once → that item falls back (rule 5).
5. Fallback = the event speaks for itself: its i-tags, type tag, first ~200 chars of content, marked "not interpreted". Never invented placeholder text. Skeleton on arrival and AI-down fallback are the same thing.

## 3. Question → search → results

- AI turns the question into ≤3 searches: `prefix:value` or free-text. Prefix list is **open** (protocol passes unknown prefixes through opaque, IR-4) — AI is *guided* toward known ones (`cve, cwe, cpe, purl, cc, fips, fcc-id, swid, gtin, pp, vendor, scheme, cc-cert-id, cc-scheme`) but any `prefix:value` is queried. Decision clauses ("still certified") become post-filters on the result set, never extra searches.
- `#i` tag queries and free-text (NIP-50) are **optional relay features**: app detects relay capability, falls back to `fullScanFilter` when needed, and tells the user ("relay X lacks search support") — never confuses that with "no matches".
- Result set may be relay-truncated: UI always shows "fetched N (relays may hold more)" when a limit is hit.
- Facet sidebar = computed from fetched events' tags, never AI. OR within a facet, AND across facets, selections as removable chips.
- Cards dedupe by product (one card per root product event, with its bound metadata). A cohort line summarizes the set ("12 products · 4 vendors · 2 retracted").
- Results view: cards; table toggle is a Could (§10).

## 4. Edge states (complete table)

| When | User sees |
|---|---|
| No AI key set | Everything works; AI texts show fallback (rule 5); hint to settings |
| AI down / garbage | Fallback for that item + small dismissible banner |
| AI slow (>10s batch, >30s chat) | Render whatever is ready; degrade only the unfinished items |
| All relays dead | Error screen: per-relay status, edit list, retry. Never demo data |
| Some relays dead | Results from the rest + corner notice |
| Relay lacks `#i`/NIP-50 | Notice naming the relay + fallback scan used — *not* "no matches" |
| Zero results (relays confirmed searchable) | "Nothing matched on your relays" + chips to broaden + relay-list hint |
| Event fails signature/id check | Silently skipped + footer count "N invalid skipped" |
| Cross-references missing (pending) | Node badge "incomplete — retrying"; auto-refetch on arrival |
| Patch chain `halted` / `forked` / `aborted` | Chain shown up to last good patch + state badge + reason |
| Retraction suspected but kind-5 unseen yet | Provisional state; re-resolves when the deletion arrives |
| Shared link → relays dead | Error screen, as above |

## 5. AI provider

- Settings: endpoint (default `https://llm.ai.e-infra.cz/v1`), key (memory-only), model picked from the endpoint's live `/v1/models` list (searchable combobox), remembered locally. Temperature 0.2.
- In-product disclosure at the key field: "Everything you send — event contents, your questions, chat — goes to this endpoint provider."
- Proof the model behaves: `tests/smoke/` = 5 canned questions + 5 **committed fixture events** (hashed, in-repo; live-fetch mode optional), one command, runs against the selected model. Pass = all outputs parse and fields are sane.

## 6. Privacy (the honest version)

- Kept locally (IndexedDB, **unencrypted** — readable by anything on this device/browser profile): relay list, chosen model + endpoint, past interpretations (`eventId·model`), saved sessions. Caveat: IndexedDB is best-effort — browsers may evict it under storage pressure, and private windows keep nothing. We request `storage.persist()` opportunistically and degrade silently if denied.
- Never persisted: the API key (memory-only; also stripped from anything serialized).
- Your relays see your IP and your exact searches; your AI provider sees event contents and questions; the static host sees page loads; shared browsed items live unencrypted in IndexedDB until "Clear all local data".
- Engineering guarantees: no third-party scripts/fonts/icons at runtime (all self-hosted), strict CSP (`connect-src 'self' https: wss:` — scheme allowlist only; CSP cannot express "only user-typed endpoints"), chat markdown rendered via `marked` + DOMPurify (every HTML path sanitized), and a test asserting the key appears in nothing serialized.
- Settings has one "Clear all local data" button.

## 7. Quality bars (cycle 1)

- Fallback/skeleton content visible instantly.
- First AI-filled content within ~10s on a normal query (partial renders allowed, §4).
- Fully usable with only 1 of the configured relays alive.
- "Works" = the §5 smoke set passes. Plus a conformance test: code asserts AI input/output surfaces match §2 rule 1 exactly (no silent AI-field growth).

## 8. Engineering

- One SvelteKit 2 app, `adapter-static` with SPA fallback page, deployed on academic servers. Path URLs (`/event/…`) need one host-level rule (nginx `try_files … /index.html`); document it in README. Svelte 5 runes only.
- `@scrutiny-fabric/core` consumed as a local `file:` dep on the sibling repo for now (SDK repo is private — a git-SHA pin resolves nowhere for other machines). When the repo goes public: switch to git-SHA pin + SDK `prepare` script. Later: npm publish. Any deploy before that requires the sibling checkout present at build time (document in README). All protocol work via the SDK; the only app-owned protocol code is the mandated verification shim (Schnorr verify via `@noble/curves` + id recompute) and relay transport.
- `nostr-tools` relay pool (list from config/env (no hardcoded addresses yet; shipped defaults TBD when the canonical SCRUTINY relays are known), 2–4 entries, user-editable; per-relay status surfaced).
- Server runtime deleted; ported to client: AI agents (query/cards/nodes/chat), zod gates, verifier, citation registry, transport. `db.ts`/`cache.ts` die → IndexedDB. The followups agent dies (chat suggests follow-ups inline if ever needed).
- Graph canvas: `@xyflow/svelte`, custom nodes, in-app (not the UI library).
- LLM streaming browser→endpoint; abort on navigation away.

## 9. UI

- Consume `beautiful-ui-svelte` as the component library (local sibling dep now, git/npm when public). Its demo components need a data-driven pass and missing atoms ported — that work is tracked in THAT repo, budgeted inside §11 step 1. No component forks in this repo.
- Design board (`Downloads/Scrutiny Session Explorer/*.dc.html`) = wireframe (owner refines); beautiful-ui = skin; harness = vibe.
- bits-ui headless for: Combobox (model picker), Tooltip, ScrollArea, Popover (share), Progress.
- Port upstream atoms: Chip, StatusPill, ValuePill, EntityChip, TextRow, SegmentedControl, Switch, Shimmer.
- App shell: three retractable columns — left rail (sessions), center (graph canvas with a collapsible **InspectorStrip** above it showing graph summary or the selected node's detail/patch history), right (chat, first-class resident, not a drawer). Same shell hosts search (A) and results (B): center swaps search → results → session; facets on B are a collapsible second-left strip styled after shadcn-ui-blocks multi-facet-panel.
- Citations: numbered inline pills à la Vercel AI Elements inline-citation (hover → source card with verbatim quote), plus the coordination store ringing the graph node.
- New components: SidebarRecents (extend SidebarNav: query, timestamp, unseen dot, close), ResultCard (seed: RecommendationCard), FacetGroup (checkbox+count rows; seed: SearchList+ToolChips), ChatMessage + SourceList (citation pills), CitationMark (colored underline from GlideHighlight) **plus a citation-coordination store** linking pill ↔ prose span ↔ graph-node ring, InspectorStrip (top strip over the canvas: node detail + citations + patch history, collapsible like the side rails), Timeline (patch history entries), EmptyState, KeyField, RelayDot.
- Writing rule: **monospace = machine-made/verified (ids, tags, hashes, quotes); sans = AI-written prose.**
- Components we expect to need from the library are tracked as an issue on beautiful-ui-svelte (not in this spec).

## 10. Scope

- **Must**: search→cards, graph, InspectorStrip (detail + patch history + retraction + chain states), chat w/ verified citations, share link, honest fallbacks, settings.
- **Could**: table view toggle (SegmentedControl + RecordsTable), saved-session auto-title, command palette (⌘K — deferred, owner-liked).
- **Won't (this cycle)**: Nostr login, trust lists, publishing events, SEO/event pages, profiles, citation hover flourish beyond the coordination store, Docker self-host bundle, multi-relay conflict UI beyond dedupe, mobile-specific work (baseline: usable at 360px, enhanced beyond).

## 11. Build order (each step ships usable)

1. Shell: delete server, static build, **vendored UI data-driven pass**, settings (endpoint/key/model/relays), IndexedDB persistence.
2. Search → fetch (capability-aware) → cards (AI + fallback) + facet sidebar + edge states.
3. Graph + InspectorStrip (detail, patch history, retractions, chain states).
4. Chat with verified citations + coordination store.
5. Share links (`/event/<nevent1…>`; nginx fallback rule documented).

## 12. This cycle's deliberate drops (the register)

Per-field provenance envelope (old spec): replaced by binary fallback rule 5 — accepted regression, recorded here so it's never "rediscovered" as a bug. Snippet rules R1–R8, eval harness, 11-VM catalog, server-side sessions table, provenance colors registry: gone with the 16-doc set. Cards' `graph` field: cards are not mini-graphs this cycle.
