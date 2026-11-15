---
name: unslop
description: Strips generated-looking code and comments from a diff or files in scrutiny-lens (comments restating the code, filler JSDoc, defensive checks the types rule out, one-caller helpers, vague names) without changing behavior. Use as the last step of any change, or when asked to clean up, trim comments, or remove slop.
---

# Unslop

Adapted from the `ui-sdk-unslop` skill in vercel-labs/ui (Apache-2.0), reworked for this repo's conventions.

Scope is the diff against the base (`git diff main...HEAD`) unless given files. Behavior never changes: the same tests pass before and after, and nothing public is renamed.

## What goes

**A comment that says what the next line does.** Delete it. If the line isn't clear without it, rename something.

**A comment on every declaration.** The name and type already say what it is. Keep a comment only if it stops a reader from getting the code wrong.

**A comment that narrates history or the task.** "Now we", "Updated to", "Fixed the bug where", "As requested". Git holds the history.

**A section banner.** `// ---- Helpers ----`. Split the file if it needs signposts.

**JSDoc that repeats the name.** Say what the reader can't see: default, unit, when it's called, what happens on change.

**A hedge or sales word.** "Robust", "seamless", "comprehensive", "simply", "just", "easily", "ensure", "leverage", "utilize", "note that". Cut the word; if nothing is left, cut the comment.

**A defensive check the types already rule out.** `if (!items) return` on `items: Item[]`, `?? []` on a value that's never undefined, `try` around code that can't throw. Narrow `unknown` once at the boundary instead.

**A cast or `!` with no reason.** Fix the type, or say why.

**A one-caller helper, or a wrapper that only renames.** Inline it unless the name explains something the call can't.

**A name that says nothing.** `data`, `result`, `item2`, `temp`, `flag`. Name what it is.

**An option nobody passes,** a parameter with one value, a config object for one setting.

**Logs, probes, and commented-out code.** Delete them. (Existing deliberate debug channels such as the gateway `dbg` calls are not slop; leave them.)

**Svelte:** a `$effect` that only derives a value (use `$derived`), and state copied from props (read the prop).

## What stays

- A comment that says **why**: a browser or library bug and which one, a trade-off, an invariant, the spec section, ADR, or issue that pins the behavior (`// spec §2 rule 5`, `// #102`). Keep these even when they run past three lines, but cut each to the reason.
- Domain terms from `CONTEXT.md`. Don't rename them to something shorter.
- JSDoc on exported symbols, made more informative rather than deleted.
- Comments that cite a trust-gate rule (never-lie §2, API-key handling). Those are load-bearing.

## Steps

1. List what you'll change, by file, before touching anything.
2. Make the changes.
3. Run `pnpm check` and the tests for what you touched. Check exit codes.
4. Delete each comment still in the diff and reread the code. If it still reads right, leave it deleted.
5. Read the diff once more. Revert any change that doesn't make the code easier to read.
