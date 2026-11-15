---
name: lens-workflow
description: GitHub process for scrutiny-lens. Use when filing or commenting on an issue, opening or updating a PR, writing a commit message, running the pre-PR review pass, labeling the board, or reporting SDK gaps. Not needed for plain coding.
---

# lens-workflow

The always-on rules (issue first, branch naming, owner-approved merges, never force-push) live in `AGENTS.md`. This is the rest.

## Issue

- One fine-grained unit of work per issue. Title plus at most five bullets: goal, acceptance, spec lines touched.
- Labels: type plus `in-progress` or `blocked`. No milestones. When blocked, comment `Stuck:` with what is missing.

## Branch and commits

- Branch `<type>/<N>-<slug>`, type one of feat, fix, chore, docs, test, refactor.
- Conventional commits, imperative, subject at most 72 characters. No sign-offs, no AI attribution.
- Spec changes are separate `docs:` commits through the spec edit ritual, never inside a code PR.

## Review pass before a PR

1. Run `unslop` on the diff.
2. Run `simplify` if it is installed (a global omp skill), then `code-review` (adversarial). Fix findings or open follow-ups.
3. UI work: run it in a browser and keep screenshots for the PR.

## PR

- Open a draft early with `Refs #N`; mark ready with `Closes #N`.
- Body is four headings: What, Why, Verification, Out of scope (plus screenshots for UI).
- One idea, roughly 200 to 400 lines.
- Merge only after the owner approves in chat.

## Writing as the owner

Anything posted under the owner's account (issue comments, PR bodies, review replies) is first person or plain impersonal. Decisions read as the owner's own. Never write about the owner in the third person ("owner ruling", "owner decision"), never narrate agent process, and explain jargon plainly because the reader is the owner.

No slop words: "comprehensive", "robust", "leverage", "seamless", "This PR".

## SDK gaps

scrutiny-lens is the first consumer of `@scrutiny-fabric/core`, and the owner maintains it. When the SDK is missing something or behaves wrong, file an issue on `crocs-muni/scrutiny-fabric-tools` (or fork and PR if trivial). In-lens, work around it minimally with a comment linking the issue. Never silently fork protocol behavior inside the app.
