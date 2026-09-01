# AGENTS.md — Build rules for AI agents

Read this before writing code. Violations of these rules are build-breaking.

## Spec authority

`docs/spec.md` is the **only** spec. If code and spec disagree, spec wins; change the spec via its edit ritual (propose a line change → owner vetoes or accepts). Never silently.

The superseded 16-doc set was removed from the tree (git history preserves it). When in doubt, spec.md rules.

## Product invariants (from spec.md — read it)

- **No app server.** Static SPA; the browser talks to Nostr relays and the user's AI endpoint directly. No telemetry, analytics, or beacons; all assets self-hosted.
- **Never lie (spec §2).** AI writes only: search translation, card texts, node titles/summaries, chat answers. Status, patch history, facets, counts, citation quotes, date comparisons are computed deterministically — never by AI. Chat quotes must match event content verbatim or the claim is dropped. AI failure → fallback that shows the event's own tags + first ~200 chars, marked "not interpreted". **Never fabricate placeholder text.**
- **API key:** memory-only, never persisted (including inside anything serialized to IndexedDB), never logged; sent only to the user's configured endpoint.

## Hard rules

- **Svelte 5 runes only.** `$state`, `$derived`, `$effect`, `$props()`. No legacy `export let`, no stores API for cross-component state.
- **All protocol work via `@scrutiny-fabric/core`** (validate/resolve/admit/store/query + tag constants) — never hand-rolled. The only app-owned protocol code is the verification shim (Schnorr verify via `@noble/curves` + id recompute) and relay transport.
- **Edges come from protocol resolution only** (bindings), never from AI inference.
- **Patch content only through `core.resolve()`** — no direct `jsdiff`/`git apply` on patch payloads.
- **nostr-tools for all relay I/O.** No `@nostr-dev-kit/ndk` imports anywhere (forbidden; CI greps).
- **kebab-case t tags only** (`scrutiny-product`, never `scrutiny_product`) — TAG-4.
- **Chat/markdown HTML:** rendered via `marked` + DOMPurify; every `{@html}` path sanitizes.
- **AI surfaces are conformance-tested**: code asserting AI input/output matches spec §2 rule 1 must pass — adding an AI-written field requires a spec line first.
- **Config, not constants:** relay pool (2–4) and AI endpoint defaults come from config/env (see `.env.example`); no secrets exist in this app.

## UI rules

- Component library: [beautiful-ui-svelte](https://github.com/aykoooo/beautiful-ui-svelte) (MIT, canon). Two-tier sourcing: zero-mutation canon components consumed via `file:` sibling-link (same mechanism as `@scrutiny-fabric/core`); components needing app mutation are vendored into `src/lib/components/ui/` WITH the token infrastructure (`tokens.css` + `primitive-*` + `.dark` variant). Canon is a faithful port and is never customized for app needs (owner ruling 2026-08-31): vendored copies are PERMANENT app code, organized shadcn-style so a design system can be extracted later. Never file upstream issues asking canon to become app-aware.
- **bits-ui** headless primitives for Combobox/Tooltip/ScrollArea/Popover/Progress.
- Graph canvas: `@xyflow/svelte`, in-app (not the library).
- Writing rule: **monospace = machine-made/verified (ids, tags, hashes, quotes); sans = AI-written prose.**

## Conventions

- pnpm; `pnpm check` must be 0 errors.
- Comments explain **why**, not what; cite spec.md sections (e.g., `// spec §2 rule 5`).

## Workflow

- **Issue first.** Every unit of work = a GitHub issue (fine-grained, per feature): title + ≤5 bullets (goal, acceptance, spec lines touched). No issue, no code.
- **Branch** `<type>/<N>-<slug>` (feat/fix/chore/docs/test/refactor). Free to commit/push/open PRs on feature branches. Never push to main, never force-push.
- **TDD where it pays:** trust gates (zod shapes, verifier, citations, query translation, fabric seam, cache) get a failing test first. UI is browser-verified visually.
- **Review pass before PR:** run `simplify`, then `code-review` (adversarial). Fix findings or file follow-ups.
- **PR:** draft early `Refs #N`; body = What / Why / Verification / Out of scope (+ screenshots for UI); ready → `Closes #N`. Small, one idea, ~200–400 lines.
- **Merge by agent only after owner's explicit chat approval.** Never push to main directly.
- **Board:** labels = type + `in-progress`/`blocked` only; `Stuck:` comment when blocked. No milestones.
- **Voice:** conventional commits, imperative, ≤72-char subject; no sign-offs or AI attribution; no slop words ("comprehensive", "robust", "leverage", "seamless", "This PR"); spec changes are separate `docs:` commits, never smuggled into code PRs.
- **GitHub artifacts read as owner-written.** Anything posted under the owner's account — issue comments, PR bodies, review replies — is first-person or plain impersonal: decisions phrased as the owner's own. Never third-person about the owner ("owner ruling", "owner decision"), never agent process narration, and explain jargon plainly (the reader is the owner). (Ruled 2026-09-02 after the #12/PR-25 rewrites.)

## SDK feedback loop (desired, not optional)

scrutiny-lens is the **first consumer** of `@scrutiny-fabric/core`, and the owner is its solo maintainer — using it is supposed to refine it. When the SDK is missing something, behaves wrong, or its API could be better: **file a GitHub issue on crocs-muni/scrutiny-fabric-tools** (or fork/PR if trivial) and work around minimally in-lens with a comment linking the issue. Never silently fork the protocol behavior inside the app.
