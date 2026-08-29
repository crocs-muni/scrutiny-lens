# SCRUTINY Lens

A static, serverless web app for exploring SCRUTINY Fabric security metadata.
The browser talks to Nostr relays and your own OpenAI-compatible LLM endpoint
directly. No app server, no accounts, no telemetry. Built on SvelteKit 2 +
Svelte 5 (runes) + TypeScript strict. Spec: `docs/spec.md`.

## Quickstart

Requires the sibling `scrutiny-fabric-tools` checkout (`@scrutiny-fabric/core`
is a `file:` dependency — see spec §8).

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # type-check (svelte-check)
pnpm test         # vitest run
pnpm build        # production build -> ./build (adapter-static lands with issue #9)
```

## Deploy

Serve `build/` with any static file server. Path-style share links
(`/event/nevent1…`) need one SPA fallback rule, e.g. nginx:

```nginx
location / { try_files $uri $uri/ /index.html; }
```

## Configuration

Defaults come from env at build time (see `.env.example`): relay list and the
default LLM endpoint. The AI key is entered in the app's settings, kept in
memory for the tab only, and sent only to the endpoint the user configured.

## License

See `LICENSE`.
