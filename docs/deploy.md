# Deploying to GitHub Pages (issue #16)

The app is a static SPA (spec §1, §8): no app server, browser talks to Nostr
relays and the user's LLM endpoint directly. Hosting is therefore a plain file
dump. The dashboard lives at a **user site** — `https://scrutiny-lens-demo.github.io`
— served by a dedicated repo, so it stays root-mounted (`BASE_PATH=''`) and the
URLs stay short. Ruled 2026-09-16.

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
  *Run workflow*): same gate → `vite build` with `BASE_PATH=''` and the baked
  relay pool → pushes `build/` to the `scrutiny-lens-demo.github.io` repo. That
  repo serves from its default branch root, so no Pages API or environments are
  involved. The build already ships `404.html` (SPA fallback for deep links)
  and `.nojekyll` (lets `_app/` through Jekyll-less).

Deploys queue (`concurrency: pages`, no cancel-in-progress).

## One-time setup (owner, ~5 minutes)

The publish step skips cleanly until all of this exists:

1. Create the GitHub account or org `scrutiny-lens-demo`.
2. In it, create a **public** repo named exactly `scrutiny-lens-demo.github.io`
   (an initial commit with a README is fine — the job replaces the tree).
3. Create a fine-grained personal access token scoped to that one repo with
   **Contents: Read and write**.
4. In `crocs-muni/scrutiny-lens` → Settings → Secrets and variables → Actions,
   add the token as `DEMO_DEPLOY_TOKEN`.
5. Actions → **pages** → *Run workflow*. The site is live one push later.

After that, every green push to `main` deploys itself.

## Configuration baked at build

- `PUBLIC_RELAY_URLS` — the first-run relay pool (spec: 1–4, user-editable in
  Settings afterwards). Currently `wss://relay.damus.io,wss://nos.lol` — `wss`
  only, because an HTTPS page cannot open `ws://`. When the canonical demo
  corpus targets a firm pool, change the one line in `pages.yml` and re-run the
  workflow. The corpus itself is published out-of-band (owner, in progress) —
  the app holds no data.
- `PUBLIC_LLM_ENDPOINT` — unset; falls back to the spec §5 default.

No deployment secrets exist beyond the push token above; the app itself is
secretless by design (API keys live in the user's browser memory, spec §6).

## Retargeting

- **Different account/domain:** the workflow pushes to one fixed repo —
  change the clone URL (and `BASE_PATH` if it becomes a project site: set it
  to `/<repo>` per README §Deploy).
- **Return to project-site Pages on this repo:** keep the gate/build steps,
  swap the publish step for `actions/configure-pages` + `upload-pages-artifact`
  + `deploy-pages` with `BASE_PATH=/scrutiny-lens` — issue #16 records the
  mount rule.

## Verification duty

`pages.yml` never deploys a red build: check + test run first in the same job.
The first real deploy is verified by loading the site, running one search
against the baked relay pool, and confirming a deep link (e.g. a `/smoke`
refresh) boots via `404.html`.
