# SCRUTINY Session Explorer

Search a hardware-certification event graph (Nostr events: products, metadata,
bindings, patches, deletions), open a session, and ask questions about it —
answers are grounded in and cited against the graph's own events, with
citations that ring/reveal the source node and open its real content.

The app needs a running SCRUTINY relay (pre-seeded with the sec-certs corpus)
and an LLM API key for the chat panel.

## Quickest way to run it: Docker Compose

You need Docker + Docker Compose, a copy of the relay image
(`scrutiny-relay-demo:latest`), and your own LLM API key.

1. Load the relay image (someone will have handed you a `scrutiny-relay-demo.tar.gz`,
   or you can build it yourself from the `scrutiny-mvp` repo's
   `packages/relay/Dockerfile`):
   ```sh
   docker load -i scrutiny-relay-demo.tar.gz
   ```
2. Copy `.env.example` to `.env` and fill in `API_KEY` (an e-INFRA API key —
   see the comment in `.env.example` for where to get one).
3. ```sh
   docker compose up --build
   ```
4. Open http://localhost:5173.

The relay's corpus is baked into its image (no volume) — recreating the
container always returns to the same clean baked state.

## Developing locally (without Docker)

Requires Node 22+, pnpm, and a running relay reachable at `PUBLIC_RELAY_URL`
(default `ws://127.0.0.1:8080`; run one via
`docker run -d -p 8080:8080 scrutiny-relay-demo:latest`).

```sh
pnpm install
cp .env.example .env   # fill in API_KEY
pnpm dev
```

Other scripts:

```sh
pnpm build        # production build (adapter-node)
pnpm preview       # preview the production build locally
pnpm check         # svelte-check
pnpm test          # unit tests (vitest)
```

## Environment variables

| Variable            | Required | Notes                                                        |
| ------------------- | -------- | ------------------------------------------------------------ |
| `API_KEY`            | yes      | LLM gateway key, used server-side only (chat/node-labeling). |
| `BASE_URL`           | no       | LLM gateway base URL. Defaults to the e-INFRA endpoint.      |
| `MODEL`              | no       | Model name/alias. Defaults to `coder`.                       |
| `PUBLIC_RELAY_URL`   | no       | Relay the **browser** connects to. Read via `$env/static/public`, so in Docker it must be set as a build arg (see `docker-compose.yml`), not a runtime env var. |

Never commit `.env` — it holds a real API key.
