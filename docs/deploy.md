# Deploying to GitHub Pages

The dashboard is a static SPA on this repo's GitHub Pages, served from the
custom domain `https://lens.scrutiny.cloud` (CNAME → `crocs-muni.github.io`,
set in Settings → Pages). The domain serves from the site root, so no
`BASE_PATH` is baked into the build; the legacy `github.io` URL redirects to
it. Deep links (`…/event/nevent1…`) resolve through the SPA fallback.

## Architecture

`.github/workflows/pages.yml` runs on every push to `main` and on manual *Run
workflow*. `gate-and-build` applies the shared `.github/actions/prepare` recipe
(pinned `scrutiny-fabric-tools` and `beautiful-ui-svelte` siblings, core build,
Node 22 + pnpm 10), then `pnpm check`, `pnpm test`, `pnpm build` and
`upload-pages-artifact` of `lens/build`; `deploy` runs `deploy-pages` into the
`github-pages` environment via the built-in `GITHUB_TOKEN` (`pages: write`,
`id-token: write`). No deployment secrets exist — the app is secretless by
design (spec §6). Deploys queue (`concurrency: pages`, no cancel-in-progress).
`.github/workflows/ci.yml` runs the same recipe on PRs without deploying.

## Configuration baked at build

`PUBLIC_RELAY_URLS`, step-scoped to the build only:
`wss://relay.scrutiny.cloud,wss://relay.damus.io,wss://nos.lol` (`wss` only —
an HTTPS page cannot open `ws://`). Our production relay leads so a fresh
visitor lands on scrutiny data; the public pair follows as fallback. At job
level it leaks into `pnpm test`, where `DEFAULT_RELAYS` must equal the
in-source spec pool. To retarget, change that one line in `pages.yml` and
re-run the workflow. `PUBLIC_LLM_ENDPOINT` is unset, so the spec §5 default
applies.

## Caching and SPA fallback

The artifact ships `404.html`, which Pages serves for unknown paths so deep
links boot the router, plus `.nojekyll` so `_app/` is served Jekyll-less.
Content-addressed `_app/immutable/` assets are safe to cache indefinitely;
`404.html` and `index.html` follow Pages' short default cache, so a new deploy
is picked up on the next load. Any non-Pages host reproduces the fallback with
`try_files $uri $uri/ /404.html;`.
