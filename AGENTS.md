# AGENTS.md

Rules for coding agents in scrutiny-lens: a static Svelte 5 SPA that searches Nostr relays and shows events with AI-written prose and deterministic facts.

## Authority

- `docs/spec.md` is the only spec and wins over code. Change it through its edit ritual (propose a line, owner accepts or vetoes), as its own `docs:` commit, never inside a code PR.
- `CONTEXT.md` fixes the domain terms (Selection, Dossier, Artifact, Citation, Subject, …); use them and avoid the listed _Avoid_ synonyms. `docs/adr/` holds settled decisions; don't reopen one without a new fact.
- `docs/ui-rules.md` covers UI. `docs/vision/agentic-harness.md` is ideas only, not a plan.

## Commands

```sh
pnpm install
pnpm dev                                 # http://localhost:5173
pnpm check                               # svelte-check, must be 0 errors
pnpm test                                # vitest: `lib` (node) and `dom` (jsdom) projects
pnpm vitest run tests/<name>.test.ts     # one file; tests/dom/** runs under jsdom
pnpm build                               # static bundle -> build/
```

`file:` deps need sibling checkouts: `../scrutiny-fabric-tools` (`packages/core` built) and `../scrutiny-design-system`. See the README.

## Definition of done

- `pnpm check` has 0 errors and `pnpm test` is green, including tests for what you changed. Trust gates (zod shapes, verifier, citations, query translation, fabric seam, cache) get a failing test first.
- UI changes were run in a browser and you report what you saw.
- Behavior and `docs/spec.md` agree.

## Map of `src/lib`

- `fabric/`: the only seam to `@scrutiny-fabric/core`, plus the verification shim. `net/`: relay transport (nostr-tools).
- `pipeline/`: search → fetch → cards, traversal, share-open. `ai/`: gateway, agents, verifier, prompts. Only the AI-written fields live here.
- `chat/`: answer parsing, citations, and `markdown.ts`, the one HTML sanitizer. `graph/`: `subject-graph.ts` (from protocol resolution) and `canvas-sim.ts` (d3-force).
- `db/`: IndexedDB persistence. `dossier.ts`, `artifacts.ts`: drawer rows; artifacts are extracted only in `artifacts.ts`.
- `*.svelte.ts`: session stores (investigation, settings, shell, chat). `components/`: `shell/ chat/ graph/ ui/` (`ui/` is vendored or app-made).

## Boundaries

- No app server, telemetry, analytics, beacons, or third-party hosts; all assets self-hosted.
- Protocol work goes through `@scrutiny-fabric/core`; the only app-owned protocol code is the verification shim (Schnorr verify via `@noble/curves` + id recompute) and relay transport.
- Never edit the SDK or the design-system sibling from here. If the SDK is missing something, file an issue on `crocs-muni/scrutiny-fabric-tools` and work around it minimally in-lens with a comment linking the issue.

## Invariants

- **Never lie (spec §2).** AI writes only search translation, card texts, node titles/summaries, chat answers. Status, patch history, facets, counts, citation quotes, date comparisons are computed, never by AI. A chat quote matches event content verbatim or the claim is dropped. AI failure falls back to the event's own tags plus its first ~200 chars, marked "raw". Never fabricate placeholder text. A new AI-written field needs a spec line first.
- **API key (spec §6).** Tab session storage only. Never in IndexedDB or anything serialized to it, never logged, sent only to the configured endpoint.
- Edges come from protocol bindings only. Patch content only through `core.resolve()`. Relay I/O only via nostr-tools (no NDK).
- Svelte 5 runes only. Config, not constants: relay pool (1–4) and AI endpoint defaults come from env (`.env.example`).
- Gated by `tests/invariants.test.ts`: kebab-case `scrutiny-*` t tags only (TAG-4), and every `{@html}` is fed by `$lib/chat/markdown`. `@nostr-dev-kit/*` is not installed, so `pnpm check` rejects an import. Everything else here is review-enforced.

## Comments and voice

- Comments explain why, not what; cite the spec (`// spec §2 rule 5`). Run the `unslop` skill last on any diff.
- Conventional commits, imperative, ≤72-char subject; no sign-offs or AI attribution; no slop words ("comprehensive", "robust", "leverage", "seamless").

## Workflow

- Issue first: no issue, no code. Branch `<type>/<N>-<slug>`. A typo or one-file chore may go straight to main; anything substantial takes a branch and PR. Never force-push.
- Merge only after the owner's explicit chat approval.
- Review pass, PR body, board labels, and how to write GitHub text: the `lens-workflow` skill.

## Skills

Repo skills are in `.agents/skills/`: the Emil Kowalski motion and gesture set, `break-ui`, `learn-taste`, `unslop`, `lens-workflow`. The motion grammar in `docs/ui-rules.md` overrides the motion skills, whose examples are React-flavored; apply the principles and add no dependency.
