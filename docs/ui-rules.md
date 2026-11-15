# UI rules

How the UI is built and why. `AGENTS.md` links here. Where this file and `docs/spec.md` disagree on a UI detail, say so in the PR and use the spec's edit ritual; don't pick silently.

## Svelte

- Runes only. Snippets over slots, callback props over events, `interface Props` above `$props()`.
- No `clsx` or `tailwind-merge`; conditional class strings stay inline.
- Every `svelte-ignore` carries a why-comment. `role="button"`, `tabindex` and the keyboard handler move together; copy `ResultCard.svelte` instead of re-deriving it.
- Prefer attachments or `$state` for element refs over a plain `let el = null`.

## Components

- Design system: `beautiful-ui-svelte`, the sibling `../scrutiny-design-system` (a `file:` dep, like the SDK). The app also scans the sibling's classes (`@source` in `src/app.css`), so the checkout is a build dependency.
- Zero-mutation canon components import from the sibling (today only `GlideHighlight`). Anything the app has to shape is vendored into `src/lib/components/ui/` and becomes app code; it is not re-synced to canon.
- `tokens.css` is the app's token source and has drifted from canon on purpose (for example `--orange-line`). Record why in the diff when it drifts again.
- Add a provenance comment (source file, license) to each vendored file. Never vendor the same component twice.
- Compositions (ResultCard, graph node cards, DetailDrawer, citation pills) are built in-app from primitives and are not library-generic.
- bits-ui supplies the headless behavior. In use: Combobox (model picker), Tooltip (via `KeyHint`), Popover (share). ScrollArea and Progress are not used; prefer native scroll. See `shell.svelte.ts` for Escape and layering quirks.

## UI SDK (vercel-labs/ui)

Under evaluation, spike only. It is beta. Where it could pay off: focus recovery for the drawer and dialogs, popup behavior, listbox typeahead, roving focus in the graph. Don't add `@ui-sdk/*` to `package.json` without the owner's say-so; a spike lives in a scratch branch behind one component (SharePopover or the settings combobox) and is judged against the real design language.

## Graph canvas

- Pure d3: `d3-force` in `src/lib/graph/canvas-sim.ts`, HTML cards on top. There is no `d3-zoom`: the camera is a derived function of stage size, bounds center, zoom and pan offset (#103).
- Motion grammar (#95): frozen baseline with no idle motion; physics only inside user gestures; every episode auto-halts and re-pins; every node is draggable; edges end at card borders.

## Typography

Monospace means machine-made or verified: ids, tags, npubs, hashes, timestamps, counts, status chips, quotes. Sans means AI-written prose: titles, snippets, chat. One field may change face with provenance (a node title is sans when interpreted, mono when raw), which is how the UI says "AI wrote this". Mono is never below 10px, and counts use `tabular-nums`. Long machine strings use shared overflow helpers, not ad-hoc slicing.

## Known gaps

- `docs/spec.md` still names `d3-zoom` (§8) and bits-ui ScrollArea and Progress (§9); the code does not use them.
- Nothing enforces the typography rule besides review.
