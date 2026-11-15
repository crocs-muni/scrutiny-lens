# Research: Nostr sharing & deep links

Phase-0 research for #31 (`/event/<nevent1…>` share links, spec §1 line 22, §10, §11 step 5).
Three client families surveyed 2026-09-16: gateways (njump, nostr.guru, nostr.band), web clients (snort, coracle, primal, iris.to), native/handlers (Amethyst, Damus, NIP-21, PWA manifest fields). Every claim cites a primary source (repo file or live probe).

## What this means for scrutiny-lens (synthesis)

1. **Our route shape is fine but off-pattern.** Ecosystem convention is `/<bech32>` or `/e/<bech32>` at the host root (njump, snort, Damus AASA, primal). We use `{origin}/scrutiny-lens/event/{nevent1…}` (spec-pinned). Consequence: native clients will never auto-match our URLs (their intent-filters/AASA claim specific hosts like njump.me, primal.net — we can't get into Amethyst's manifest). Deep-link handoff must flow the other way: our page emits `nostr:nevent…` and the OS routes it.
2. **Per-event unfurl is impossible on our hosting — and we're in good company.** Only server-rendered gateways (njump, nostr.guru) and snort (Cloudflare Pages middleware + external `nostr-rs-api`) produce per-event og cards. Primal and iris.to are pure SPAs and unfurl as a generic logo / blank card. Coracle ships no og meta *at all* by design and documents the crawler behavior in its nginx config. Static-SPA share links are normal in this ecosystem; the recipient experience gap is entirely pre-load.
3. **Hint policy: observed relays, ≤3.** Coracle (welshman router, `.limit(3)`, seen-on relays), njump (first ≤3 from per-event observation KV), snort (uncapped seen-on + event-carried relay tags), primal (0 hints in the share URL — leans on its cache relay instead), iris (bare `note1`, no hints — and obscure events silently never resolve for recipients). Nobody does NIP-65 outbox discovery at share *generation* time; njump uses the author's kind:10002 write relays only at *fetch* time, prioritized after inbound hints.
4. **Two copy channels is the norm.** Primal: "Copy note link" (own-domain URL) vs "Copy note ID" (`nostr:nevent…` NIP-21 URI with relays+author+kind). Coracle: "Link" = full NIP-21 URI vs "Event ID" = bare note1. njump: "Your default app" = literal `nostr:{code}` href, plus a platform-filtered client list (pure JS, `Android intent:` URIs / iOS custom schemes / `https://{code}` for web clients — clients.json).
5. **PWA `protocol_handlers` solves nothing.** Plain `nostr:` is not registerable (only W3C-safelisted or `web+<x>`); the coined `web+nostr:` is emitted by no one; support is desktop Chromium only (Android Chrome: no; Firefox: defer; Safari: no). Nostria and coracle declare it anyway. Coracle also calls `navigator.registerProtocolHandler` for `web+nostr`/`nostr` → `${origin}/%s` — cheap progressive enhancement, not a mechanism.
6. **PWA `share_target` is decoration for us.** Android-Chrome-installed PWAs can receive text/url shares; iOS Safari: no; Firefox: no. Value for a read-only lens: low.
7. **iOS universal links are irrelevant until custom domain + native app.** AASA is servable as a static file (Damus's is even served octet-stream), but it must live at the claimed domain's apex, and we have no iOS app. On `crocs-muni.github.io/scrutiny-lens` neither is possible.
8. **Dead-hint failure mode is the recipient's lived experience.** iris.to (no hints) → infinite "Loading…" then inline failure. Primal (hintless) → EOSE then NotFound. Our spec §4 edge row already pins: shared link + dead relays → error screen. Every SPA family implements *some* inline honest failure; nobody shows a 404-shaped fake.

---

## Gateways: njump, nostr.guru, nostr.band

### URL shape

- **njump** (`fiatjaf/njump`): catch-all `/{code}` for any NIP-19 entity or NIP-05 `name@domain`. Canonical share form = `/{enriched nevent}` **with hints + author TLV**; bare hex / `note1` / hintless nevent get **302-canonicalized** to it (`render_event.go` L41-45, L67-75; encode at `data.go` L160-165: `nip19.EncodeNevent(id, relaysForNip19, pubkey)`). Accepts `nostr:`-prefixed input by stripping and 302ing. Legacy routes `/e/<hex>`, `/p/<hex>`, `/embed/<code>`. — https://github.com/fiatjaf/njump/blob/master/main.go, render_event.go
- **nostr.guru** (`fiatjaf/nostr-gateway`, legacy Next.js): `[anything]` route SSR-redirects nevent/note → `/e/<hex>?relays=<comma>`; inbound hints survive as a query param. — pages/[anything].js
- **nostr.band**: no per-event pages at all; profiles `nostr.band/<npub>` + a script-tag embed widget keyed by hex id (`nostrband/nostr-embed`).

### Relay-hint policy

- **njump**: inbound hints honored, then **superseded by its own observations**. Fetch priority: (1) relays from the incoming pointer → (2) author's NIP-65 kind:10002 write relays (`FetchOutboxRelays(author, 3)`, `sdk/outbox.go`) → (3) cache/fallback set (`wss://cache2.primal.net/v1`, `relay.noswhere.com`, `relay.damus.io`). Generated links embed `relaysForNip19` = **first ≤3 relays where *njump itself saw* the event** (per-event KVStore, pool middleware `TrackEventHintsAndRelays`), persisted + merged into a hints DB. — data.go L147-165, nostr.go L21-34, hints.go
- **nostr.guru**: inbound hints verbatim **∪** 17 hardcoded fallbacks. No outbox logic. — utils/get-event.js, utils/nostr.js
- **nostr.band embed**: one WebSocket to one relay (default `wss://relay.nostr.band`). No hint fan-out.

### og-meta/unfurl approach

- **njump**: full per-request SSR. Event og:title = kind label + subject + author; description = summary or first ~240 chars (npub refs → names); og:image = extracted content image, else **server-rendered text→PNG** at `/image/<code>` for text-only notes >133 chars; per-Unfurler user-agent sniffing (twitter/telegram/slack/discord instant-view variants); `twitter:card` summary/summary_large_image; oEmbed endpoint + `Link: rel=alternate` headers; image *proxy* at `/proxy?src=` to defeat hotlink limits. — render_event.go L90-130, L317-365, opengraph.templ, oembed.go
- **nostr.guru**: SSR head chosen by bot UA; og:image = content image else serverless canvas `/api/noteimage?text=…`.
- **nostr.band**: profiles render og server-side (verified archived snapshot); no per-note og.

### Open-in-app mechanism

- **njump**: curated per-kind client list (`clients.json` + `clients.go`): "Your default app" = **literal `nostr:{code}` href**; "default web" = `web+nostr:{code}`; iOS custom schemes (`damus:`, `primal:`, `nostur:…`); Android `intent:{code}#Intent;scheme=nostr;package=…`; web clients `https://…/{code}`. Client-side JS only *filters/sorts* the list by platform + localStorage usage — no scheme interception; deep links are plain hrefs. — clients.templ L90-180
- **nostr.guru**: copy toggles + a browser-side "Republish Event" button (re-publishes to fallback relays). No deep links.
- **nostr.band embed**: "Copy addr" button; no verified `nostr:` handoff.

### What breaks without a server (enumerated, njump as ceiling)

1. Per-event og/title/description/image (≤ the big one — bots don't run JS)
2. HTTP-level canonicalization redirects (hex/note/hintless → enriched nevent)
3. Server-generated og:image (text→PNG) + og:image proxying
4. Unfurler-UA sniffing served markup variants
5. oEmbed + `Link` discovery headers
6. Per-profile sitemap/RSS/XML
7. NIP-05 → pubkey resolution inside URLs
8. Cross-visit accumulated per-event relay knowledge (KVStore) — a SPA knows only this-session hints/observations

**Survives fully client-side:** NIP-19 decode → traverse (hints + NIP-65 fetches); rendering; signature verification; `nostr:`/`web+nostr:`/`intent:` hrefs; platform-filtered open-in list; copy affordances; JS `document.title` (humans see it, bots don't).

## Web clients: snort, coracle, primal, iris.to

### URL shape & relay hints per client

| Client | Share URL | Hints in share link | Hints source |
|---|---|---|---|
| snort | `snort.social/<nevent1…>` (naddr for 30000-39999, nprofile for profiles) | yes, uncapped | seen-on relays + event-carried `relay`/`r` tags (`nostr-link.ts`) |
| coracle | `app.coracle.social/notes/<nevent1…>` (root `/:entity` catch-all also valid) | **≤3** | welshman router seen-on relays, +author+kind TLV (`NoteActions.svelte`) |
| primal | `primal.net/e/<nevent…>` — **id-only, zero hints** (`noteIdShort`); longform vanity `primal.net/<user>/<d>` | none in URL; `noteId` (nostr:-copy) has 2-3 `r`-tag relays + author/kind | event `r` wss-tags, `.slice(0,2)`/`(0,3)` (`megaFeed.ts`) |
| iris.to | `iris.to/<note1…>` — **bare note, no TLV** | none | — (`FeedItemDropdown.tsx`) |

Inputs: all accept wider forms than they emit (snort: nevent/naddr/note/npub/nprofile + `/e/`, `/p/`, NIP-05; coracle: any bech32 entity; primal: note/nevent/naddr/hex at `/e/`; iris: prefix-dispatched at root).

### og-meta/unfurl (live-verified 2026-09-16)

- **snort**: REAL per-event meta via Cloudflare Pages Functions middleware: intercepts entity routes, POSTs fetched shell to `https://nostr-rs-api.v0l.io/opengraph/<id>?canonical=…`, rewrites head, 3 s timeout → plain shell. Real nevent → `<title>jb55: …</title>`, og:title, avatar og:image; fabricated id → generic "Snort - Nostr". Upstream `nostr-rs-api` source not public. — functions/_middleware.ts
- **primal**: static og everywhere ("Primal — Live Free"; verified live). Resolution leans on primal's cache relay: fetch by id from `PRIMAL_CACHE_URL` + pool, EOSE → NotFound. Hints in incoming links discarded by design.
- **coracle**: nginx `try_files … /index.html`; index.html has **no og meta and no `<title>`** — deliberate; nginx comment documents crawlers landing on the SPA fallback. Rate-limits shell paths (10 r/s).
- **iris.to**: og skeleton with **empty content values** (verified live). Loading spinner → inline `Failed to load…` / Page404. Zero-hint share links = obscure events never resolve for recipients.

### Open-in-app / copy differentiation

- **snort**: `navigator.share` (mobile) else clipboard of own-domain URL; `copyId()` = bare nevent; unsupported kinds get a "Native App" button emitting `nostr:` + up to 5 NIP-89 handlers. No registerProtocolHandler.
- **coracle**: Details modal splits **"Link" = full NIP-21 `nostr:` URI** vs **"Event ID" = bare note1**; NIP-89 "Open with" popover (web+nevent > web+note > bare > per-OS); registers `web+nostr`+`nostr` protocol handlers → `${origin}/%s` (App.svelte).
- **primal**: "Copy note link" (own-domain hintless URL) vs "Copy note ID" (**`nostr:nevent…` with 2-3 relays + author/kind**). No registerProtocolHandler.
- **iris**: "Copy link" (`https://iris.to/<note1>`) vs "Copy Event ID" (bare note1). Nothing else.

## Native & handlers: NIP-21, Amethyst, Damus, PWA manifest

### NIP-21 / NIP-19 facts

- `nostr:<bech32>`, single opaque token, all NIP-19 entities except `nsec`. TLVs: `0`=id/d, `1`=relay (repeatable, advisory — "a relay in which the entity is more likely to be found"), `2`=author, `3`=kind; unknown TLVs ignored. Both NIPs draft/optional. — nips/21.md, nips/19.md
- Ecosystem link-shape convention (relevant to future custom domain): bech32 token at host root — Amethyst intent-claims `https://njump.me/*`, `primal.net/{e,p,a}/*`, `iris.to/*`, etc.; Damus AASA claims `/nevent*`, `/note1*`, `/npub*`, `/nprofile*`, `/r/*`. Nobody claims a nested `/event/<nevent>` route — ours won't be natively matched anywhere.

### Handler mechanics

- **Amethyst**: `nostr:` VIEW/BROWSABLE filter on MainActivity (+`amethyst:`, NFC NDEF). Its https host-filters have **no `autoVerify`** → chooser, not silent open. We can't add our host without an Amethyst PR. — AndroidManifest.xml
- **Damus**: `nostr:`/`damus:` custom schemes (per-navigation iOS confirmation dialog) + universal links on `damus.io` (AASA: `/nevent*` etc., silent open).
- **PWA `protocol_handlers`**: desktop Chromium ≥96 only; Android Chrome **no** (BCD Mar 2025 correction), Firefox defer, Safari no. Only safelisted/`web+<x>` schemes → **`web+nostr:`**, coined by Nostria (maps to `/?nostr=%s`), emitted by nobody. On GitHub Pages: manifest is static, scope-relative handler URL under `/scrutiny-lens/` is legal — hosting is not the blocker; utility is.
- **PWA `share_target`**: Android Chrome ≥76 (WebAPK), desktop Chrome/Edge; iOS Safari / Firefox: no. Read-only lens = low value.
- **iOS universal links**: AASA is a plain static file (works served octet-stream — Damus), but must sit at the claimed domain's apex + requires a native app. Not reachable on `crocs-muni.github.io/scrutiny-lens`, irrelevant until custom domain + native app.

### Known caveats nobody fixes

- iOS `nostr:` shows a confirmation dialog every tap.
- Android <12: any app can grab `nostr:` unverified; multiple clients installed → chooser; https App Links fallback to browser (Android ≥12) — custom scheme avoids this *because* there's no browser fallback.
- iOS web-only user with no client installed tapping `nostr:…` → dead "no app" state unless the page detects and offers a gateway fallback.

## Primary sources

- NIPs: https://github.com/nostr-protocol/nips/blob/master/19.md, /21.md
- njump: https://github.com/fiatjaf/njump (main.go, render_event.go, data.go, hints.go, nostr.go, clients.go/clients.json/clients.templ, opengraph.templ, oembed.go)
- nostr.guru: https://github.com/fiatjaf/nostr-gateway (pages/[anything].js, utils/nostr.js, utils/get-event.js, pages/api/noteimage.js)
- nostr.band embed: https://github.com/nostrband/nostr-embed
- snort: https://github.com/v0l/snort @7e1b6e6 (packages/app/src/Components/Event/Note/NoteContextMenu.tsx, packages/system/src/nostr-link.ts, functions/_middleware.ts, config/default.json)
- coracle: https://github.com/coracle-social/coracle @aa5dcbc (src/app/App.svelte, util/router.ts, shared/NoteActions.svelte, shared/NoteInfo.svelte, nginx.conf)
- primal: https://github.com/PrimalHQ/primal-web-app @c96ee21 (src/components/Note/NoteContextMenu.tsx, stores/megaFeed.ts, pages/Thread.tsx, index.html)
- iris: https://github.com/irislib/iris-client @d05eaa7 (src/shared/components/event/reactions/FeedItemDropdown.tsx, pages/NostrLinkHandler.tsx, pages/thread/index.tsx, index.html)
- Amethyst: AndroidManifest.xml — https://github.com/vitorpamplona/amethyst/blob/main/amethyst/src/main/AndroidManifest.xml
- Damus: Info.plist, entitlements, https://damus.io/.well-known/apple-app-site-association
- PWA: MDN protocol_handlers/share_target + BCD JSON, chromestatus 5151703944921088, https://raw.githubusercontent.com/nostria-app/nostria/main/public/manifest.webmanifest
- Live probes (2026-09-16): snort.social real vs fabricated nevent og; primal `/e/<nevent>` static og; iris `<note1>` empty og placeholders.
