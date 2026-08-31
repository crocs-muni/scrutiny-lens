# SCRUTINY Lens

A static, serverless web app for exploring SCRUTINY Fabric security metadata.
The browser talks to Nostr relays and your own OpenAI-compatible LLM endpoint
directly. No app server, no accounts, no telemetry. Built on SvelteKit 2 +
Svelte 5 (runes) + TypeScript strict. Spec: `docs/spec.md`.

## Quickstart

Requires Node >=22.12 and the sibling `scrutiny-fabric-tools` checkout beside
this repo (`@scrutiny-fabric/core` is a `file:` dependency — see spec §8). The
sibling's `packages/core` must be **built** (`pnpm install && pnpm build`
inside it) — its exports point at `dist/`.
A second sibling, `scrutiny-design-system` (beautiful-ui-svelte), is also a
`file:` dependency (spec §9): zero-mutation canon components are imported by
source path from it, and Tailwind scans its `src/` (`@source` in `app.css`).
Any deploy before these repos move to a public pin needs both checkouts
present at build time.

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # type-check (svelte-check)
pnpm test         # vitest run
pnpm build        # static bundle -> ./build (adapter-static)
```

## Deploy

The build is a pure SPA: `build/index.html` is the fallback page for every URL
(spec §8), so the site runs on any static file server at root mount. A postbuild
step also copies it to `build/404.html` for GitHub Pages, and
`static/.nojekyll` ships so `_app/` assets are published.

- **GitHub Pages:** serve `build/` as-is (decision record: issue #16). Deep
  links (`/event/nevent1…`) boot via `404.html` (unmatched paths return HTTP
  404 status — a soft-404). Project-site deployments
  (`<org>.github.io/<repo>`) must build with `BASE_PATH=/<repo>` so asset and
  router paths are prefixed.
- **nginx:** one host rule serves deep links:

  ```nginx
  location / {
      try_files $uri $uri/ /index.html;
  }
  ```

- **Apache:** the shipped `static/.htaccess` (`FallbackResource /index.html`)
  handles it without mod_rewrite.

Caching contract: `_app/immutable/*` is content-hashed — long-cache it
(`immutable, max-age=31536000`); `index.html` must revalidate
(`no-cache, must-revalidate`), or redeploys serve a stale module graph.

Subpath hosting anywhere (`/~user/lens/`) requires rebuilding with
`BASE_PATH` set — `kit.paths.base` is a build-time constant.

## Configuration

Config surface lands with issue #11 (`PUBLIC_RELAY_URLS` defaults, settings
dialog). The AI key will be entered in settings, kept in memory for the tab
only, and sent only to the endpoint the user configures.

## License

See `LICENSE`.
