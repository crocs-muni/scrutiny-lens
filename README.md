# SCRUTINY Lens v2

SCRUTINY Lens explores Nostr session graphs and interprets them with an
OpenAI-compatible LLM. Built on SvelteKit 2 + Svelte 5 (runes) + TypeScript
strict, persisting to `node:sqlite`.

## Quickstart

```sh
pnpm install
cp .env.example .env   # fill in API_KEY (app degrades gracefully without it)
pnpm dev          # http://localhost:5173
pnpm check        # type-check (svelte-check)
pnpm test         # vitest run
pnpm build        # adapter-node build -> ./build
```

## Environment

| Variable            | Required | Default                          |
| ------------------- | -------- | -------------------------------- |
| `API_KEY`           | yes      | — (app degrades: `no_key`)       |
| `BASE_URL`          | no       | `https://llm.ai.e-infra.cz/v1`   |
| `MODEL`             | no       | `coder`                          |
| `PUBLIC_RELAY_URLS` | no       | `ws://localhost:8080/ws`         |

Browser BYOK (ADR-018): clients may pass a per-request provider override;
override keys are never persisted or logged server-side.

## Docker

```sh
cp .env.example .env
docker compose up --build   # explorer on :5173, relay on :8080
```

## License

See `LICENSE`.
