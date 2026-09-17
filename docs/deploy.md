# Deploying to GitHub Pages (issue #16)

The app is a static SPA (spec §1, §8): no app server, browser talks to Nostr
relays and the user's LLM endpoint directly. Hosting is therefore a plain file
dump. The dashboard lives at this repo's **project site** —
`https://crocs-muni.github.io/scrutiny-lens` — root-of-repo, no extra account
or repo, no secrets. Ruled 2026-09-16 (supersedes the user-site idea from
earlier the same day, rejected to avoid a second GitHub account).

Deep links mount under the path prefix the same way as at a root mount:
`…/scrutiny-lens/event/nevent1…` resolves through the same SPA fallback
(`kit.paths.base` strips the prefix for the router). Paste-sharing works
identically; only the URL text is longer.

## Architecture

Two workflows, one shared recipe:

- `.github/actions/prepare` — composite action that reproduces the local `file:`
  dependency layout in CI: checks out `crocs-muni/scrutiny-fabric-tools` and
  `aykoooo/beautiful-ui-svelte` at **pinned SHAs** into the sibling paths the
  lens lockfile expects, builds `@scrutiny-fabric/core` (`tsc → dist`), installs
  Node 22 + pnpm 10 + lens deps. Bump the two SHAs deliberately; never float
  `main` — a fabric-tools drift must not silently break a lens deploy.
- `.github/workflows/ci.yml` — PR + main-push gate: recipe → `pnpm check` →
  `pnpm test`.
- `.github/workflows/pages.yml` — on every push to `main` (plus manual
  *Run workflow*), two jobs: `gate-and-build` (recipe → check → test →
  `vite build` with `BASE_PATH=/scrutiny-lens` and the baked relay pool →
  `upload-pages-artifact`) then `deploy` (`deploy-pages` into the
  `github-pages` environment, authenticated by the built-in `GITHUB_TOKEN`
  with `pages: write` + `id-token: write` — no secrets configured at all).
  The build ships `404.html` (SPA fallback for deep links) and `.nojekyll`
  (lets `_app/` through Jekyll-less).

Deploys queue (`concurrency: pages`, no cancel-in-progress).

## One-time setup (owner, one click + one dispatch)

1. `crocs-muni/scrutiny-lens` → Settings → Pages → Build and deployment →
   Source = **GitHub Actions**. (Equivalent API call from anywhere with an
   admin token: `gh api repos/crocs-muni/scrutiny-lens/pages -X POST -f build_type=workflow`.)
2. Actions → **pages** → *Run workflow*.

The site is live at `https://crocs-muni.github.io/scrutiny-lens` one deploy
later. After that, every green push to `main` redeploys itself.

## Configuration baked at build

- `PUBLIC_RELAY_URLS` — the first-run relay pool (spec: 1–4, user-editable in
  Settings afterwards). Currently
  `wss://lens-demo.feeds.relay.tools,wss://relay.damus.io,wss://nos.lol` —
  `wss` only, because an HTTPS page cannot open `ws://`. The demo corpus
  relay leads: a fresh visitor must land on the seeded corpus (published
  out-of-band 2026-09-17), the public pair follows for anything else. To
  retarget, change the one line in `pages.yml` and re-run the workflow.
- `PUBLIC_LLM_ENDPOINT` — unset; falls back to the spec §5 default.

No deployment secrets exist at all; the app itself is secretless by design
(API keys live in the user's browser memory, spec §6).

## Retargeting

- **Custom domain at a root mount** (the pretty-URL upgrade when the spec §1
  `/event/…` pages resume): add the domain's CNAME in Settings → Pages, set
  `BASE_PATH: ''` in `pages.yml` — nothing else changes. Pasted links from
  the path-mounted era would need redirects, so mount changes belong to
  feature boundaries, not casual edits.
- **User-site repo (pretty URL without a domain):** requires a separate
  account/org plus a `contents: write` PAT the workflow pushes with — ruled
  out (no second account wanted, no secrets wanted).

## Verification duty

`pages.yml` never deploys a red build: check + test run first in the same
run. The first deploy is verified by loading the deployed URL, running one
search against the baked relay pool, and confirming a deep link (e.g. a
`/scrutiny-lens/smoke` refresh) boots via `404.html`.
