# PIR #1196 Review Iteration 1 Rebuttals

## Codex: review artifact scope

**Disposition: rebutted, wording clarified.**

The review's 59-file count and inclusion of the root `.codex/skills/**` tree
match GitHub's canonical upstream PR:

```text
gh pr view 1197 --repo cluesmith/codev --json files --jq '.files | length'
59
```

The consultation prompt listed 27 files because its local comparison baseline
already includes contributor commit `25e1a000` (`add .codex/skills/`). Upstream
`cluesmith/codev:main` does not contain that commit, so GitHub correctly
includes the root mirror in PR #1197. The retrospective now avoids a volatile
line-total and explicitly explains why the contributor commit is in the
upstream PR; its **Things to Look At** section also flags the baseline
difference for the human reviewer.

## Codex: stale init/adopt module headers

**Disposition: accepted and fixed.**

Updated `packages/codev/src/commands/init.ts` and
`packages/codev/src/commands/adopt.ts` to describe the actual current
lifecycle: minimal user-owned structure plus materialized provider
skills/root instructions/governance starters, while framework files continue
to resolve from the package at runtime. This is a documentation-only
correction; the already-covered lifecycle behavior is unchanged, so no new
regression test is warranted.

## Gemini

Gemini approved with no requested changes.
