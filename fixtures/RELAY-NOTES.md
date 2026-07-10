# Relay capability notes

Source: `/btw` fork response from the relay-building session.

## NIP-50 search
- **Yes**, via bluge full-text backend running alongside Badger.
- Indexes **full event content string**, not tags.
- `{"search":"AES"}` matches text in `content`, not `#i`/`#k`/`#e` tag values.
- Plain (non-search) `REQ`s go through Badger only.
- Search-filtered `REQ`s go through bluge only.
- The two backends are appended, not merged, so an empty/absent `search` filter never touches bluge.

## NIP-45 COUNT
- Only Badger `CountEvents` is wired.
- No bluge-backed COUNT.
- `COUNT` with a `search` filter will not return meaningful results.

## NIP-09 deletions
- **Not honored.**
- `kind:5` events are stored like any other event.
- The target event is retained, not removed.
- Any "effective view" / retraction logic must be computed client-side.

## Rate limits / auth
- None observed.
- No auth requirement.
- No rate limiting wired.

## Local dev URL
- Browser/host: `ws://localhost:7777`
- Inside Docker Compose network: `ws://relay:8080`

## Implications for the app
- Identifier queries (CVE, cc, vendor, cert id) should use `#i` tag filters against Badger.
- Freetext queries should use the `search` filter.
- Do not rely on `COUNT` for search results.
- Treat `kind:5` as an overlay/retraction signal in the client-side resolver, not as a hard delete.
