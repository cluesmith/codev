# Plan iter2 rebuttals / dispositions

Gemini: APPROVE. Codex: REQUEST_CHANGES. Claude: REQUEST_CHANGES. Every claim was checked against the code before acting.

## Codex
1. `.claude/settings.local.json` informational contradicts spec: ACCEPTED. It is exit-bearing again, with a "harness-written, usually benign" annotation. The spec allows only eligible files and `.consult/` as exemptions.
2. Index changes invisible to porcelain+hash: ACCEPTED. Added a SHA-256 of `git ls-files --stage -z` to the snapshot, with a test for re-staging an already-staged path.

## Claude
1. validateHotFile forks hot-tier.test.ts rules: ACCEPTED (verified helpers at hot-tier.test.ts:34-89). The helpers move to the library and the test imports them. The map rule adopts the shipped topic/prefix semantics, plus a new exactly-one-section requirement.
2. adopt mock missing execFileSync: ACCEPTED; named in phase 6.
3. Tests depending on the built skeleton: ACCEPTED; read `codev-skeleton/` via a repo-root path, as hot-tier.test.ts does.
4. Mixed-starter criterion untestable: ACCEPTED (verified: the pre-#1012 lines are a subset of the current starter). The rule is kept and tested with a synthetic two-version set.
5. Headless commands (`claude -p`, `codex exec`): ACCEPTED; treated as unsupported, with a reason.

## Gemini (advisory)
- A non-zero agent exit or spawn error is now reported and exit-bearing; drafts are kept.
