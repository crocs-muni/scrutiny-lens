# Scrutiny Lens

## Run with Docker

```sh
docker load -i scrutiny-relay-demo.tar.gz
cp .env.example .env   # fill in API_KEY
docker compose up --build
```

Open http://localhost:5173.

## Run locally

```sh
pnpm install
cp .env.example .env   # fill in API_KEY
pnpm dev
```

Needs a relay running at `PUBLIC_RELAY_URL` (default `ws://127.0.0.1:8080`):

```sh
docker run -d -p 8080:8080 scrutiny-relay-demo:latest
```

Other scripts: `pnpm build`, `pnpm preview`, `pnpm check`, `pnpm test`.

## Environment variables

| Variable          | Required | Default                          |
| ----------------- | -------- | --------------------------------- |
| `API_KEY`          | yes      | —                                  |
| `BASE_URL`         | no       | `https://llm.ai.e-infra.cz/v1`     |
| `MODEL`            | no       | `coder`                           |
| `PUBLIC_RELAY_URL` | no       | `ws://localhost:8080`             |
