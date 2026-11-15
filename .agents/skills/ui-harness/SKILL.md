---
name: ui-harness
description: Capture and compare scrutiny-lens UI states with the local screenshot harness (fake relays, stubbed AI, fixed clock). Use when verifying a UI change in a real browser, producing before/after evidence, checking a spec §4 edge state, or running an unattended UI improvement loop.
---

# ui-harness

`harness/` puts the built app into named, deterministic states and captures them. Everything is local and gitignored (`.harness/`). It is a feedback loop and PR evidence, not a CI gate.

## Run it

```sh
pnpm build                                   # the harness serves ./build
pnpm -s harness list                         # scene ids (JSON)
pnpm -s harness shots --label head           # all scenes, both themes
pnpm -s harness shots --label head --scene dossier-c-halted --theme dark
pnpm -s harness ledger --runs 5              # noise floor -> .harness/noise.json
pnpm -s harness compare --base last          # head = fresh capture
pnpm -s harness compare --base run:before --head head
pnpm -s harness compare --base main          # worktree build of origin/main, cached by sha
```

Use `pnpm -s` when parsing stdout; plain `pnpm harness` prepends a banner. Compare exits 0 when nothing changed beyond the noise floor, 1 when something changed, 2 on error.

## What you get
- `.harness/runs/<label>/<scene>.<theme>.png` plus a `.json` of facts: DOM text, page errors, console errors, failed requests, relay frames, `missingText`.
- `run.json`: shas of the lens and both sibling checkouts (a design-system commit repaints every scene), browser version, fixture checksums.
- `.harness/compare/<base>..<head>/`: `summary.json` (small, safe to read in full), `full.json`, `index.html` (open it to look), diffs, text deltas, and a `score` object (`changedScenes`, `changedPixels`, `addedTextLines`, `removedTextLines`, `newErrors`).

## Rules for a UI loop
1. **Measure first.** Run `ledger` before comparing; noise below `maxPixels` is not a change. Compare refuses runs from different browser versions.
2. **The gates are not yours to edit.** Fixtures, `expect` text, noise floor, and metric definitions belong to the owner. Never make a scene pass by deleting content, hiding overflow, or shrinking text. A scene fails if its `expect` text is not visible.
3. **Look at the images.** A green summary does not mean the state is right. Open the PNG or `index.html` for every changed scene.
4. **One change per round, repair before adding.** A regression on one screen costs more than a new feature gains.
5. **Judge on the diff, not the number.** Vision-model verdicts are noisy: judge changed scenes pairwise, in both orders, and never judge pixel-identical scenes.
6. Constraints still apply: `docs/ui-rules.md` (mono floor, motion grammar), `docs/spec.md` §2 and §4, and no change that makes AI prose look like verified data.

## Known limits
- Fonts are this machine's system fonts; screenshots are comparable only on the same machine and browser build.
- Fake relays do not prove protocol behavior; the real relay is a separate canary.
- Elapsed-time labels in the trace row are masked; anything else that varies per run belongs in the ledger, not in a mask.
