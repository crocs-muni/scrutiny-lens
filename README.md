# SCRUTINY Lens

SCRUTINY Lens is a client for the [SCRUTINY Fabric](https://github.com/crocs-muni/scrutiny-fabric-tools) protocol, built as a static web application. It is the reference implementation that exercises the protocol's SDK, `@scrutiny-fabric/core`, in production.

An analyst asks a question in plain English or pastes an identifier such as a CVE, a package URL, or a certificate id. Identifiers go directly to tag queries. An AI endpoint the user chooses translates free-text questions to searches. The app verifies every event it receives (Schnorr signature and id recompute), builds the product graph through the SDK, and presents a results page with cards, facets, a detail drawer, and a chat whose citations are verified against the event content.

The application runs without an app server. The browser talks only to the Nostr relays and to the user's own AI endpoint. There are no accounts, and there is no first-party telemetry. The API key stays in the memory of the open tab and goes only to the configured endpoint.

## Use the app

Live instance: <https://crocs-muni.github.io/scrutiny-lens>

Searching and browsing need no setup. The optional AI features (search translation, card texts, chat answers with verbatim-verified citations) need an OpenAI-compatible endpoint, a model name, and an API key. These are entered in the Settings dialog (`Ctrl+,`) and persist across sessions except the key, which is never stored. The full set of first-run env variables lives in `.env.example`.

AI writes only the prose layer. Every counter, status pill, facet, and date comparison is computed from the event data. When an AI item fails its shape check, the card falls back to the event's own tags and opening text, marked raw.

## Develop

Prerequisites: Node >=22.12, pnpm, and two sibling checkouts next to this repository. `@scrutiny-fabric/core` and `beautiful-ui-svelte` are `file:` dependencies, so both repositories must be present at build time, and the SDK's `packages/core` must be built (`pnpm install && pnpm build` inside it).

```sh
pnpm install
pnpm dev      # http://localhost:5173
pnpm check    # type-check (svelte-check)
pnpm test     # vitest
pnpm build    # static bundle -> ./build (adapter-static)
```

## Deploy

The build is a pure SPA. Any static file server can host it at domain root. GitHub Pages is the documented target: `build/404.html` boots deep links, and `static/.nojekyll` keeps `_app/` assets published. A project-site mount (such as `/scrutiny-lens/`) requires `BASE_PATH=/<repo>` at build time. Caching: `_app/immutable/*` is content-hashed and safe for long cache headers; `index.html` must revalidate. The full recipe, including the nginx fallback rule and this repository's automated Pages pipeline, is in [`docs/deploy.md`](docs/deploy.md).

Two environment variables seed the first-run defaults: `PUBLIC_RELAY_URLS` (comma-separated relay list) and `PUBLIC_LLM_ENDPOINT` (AI endpoint override). All further configuration lives in the Settings dialog.

## Documentation

- [`docs/spec.md`](docs/spec.md) is the single source of truth for the build cycle. Code that disagrees with the spec is wrong, and the spec changes through its own edit ritual.
- [`AGENTS.md`](AGENTS.md) states the rules for contributors and coding agents; [`CONTEXT.md`](CONTEXT.md) fixes the domain vocabulary that issues, code, and comments use.

## License

MIT. See [`LICENSE`](LICENSE).
