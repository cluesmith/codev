**Coverage gaps**
- **Prompt is not fully “drop-in ready” per brief.** It contains repo-specific references (`packages/codev/src/agent-farm/__tests__/e2e/`, `Tower`, `porch`, `status.yaml`) and a companion-file link. The brief asked for no project-specific refs.
  - **Change:** remove the blockquote intro and rewrite item 4 to:  
    **“Playwright/E2E fit.** Do not request new E2E tests unless the plan names them for this phase and the review context can actually run that harness. Existing Playwright config or prior E2E tests alone are not a reason to block.”
- **Report does not show frequency explicitly enough.** The brief wanted ordering by frequency × generalizability; the report mostly gives project counts and consensus labels.
  - **Change:** add `Appears in X objections / Y rebuttal files / Z projects` to each pattern and false-alarm heading.
- **Corpus accounting is inconsistent.** The report says “22–23 distinct projects,” then later excludes 589 and 671.
  - **Change:** make scope exact: `71 Codex-containing rebuttal files across 21 distinct projects; 23 corpus projects total, with 671 containing no Codex section and 589 skipping Codex.`

**Factual errors**
- **FA3 uses invalid evidence.** `0117-review-iter1-rebuttals.md` is a porch JSONL parser bug; the file says Codex’s actual verdict was APPROVE. That is not a Codex false alarm and cannot be fixed by prompting Codex.
  - **Change:** remove `0117` from FA3 and replace it with a real Codex semantic-misread example, or downgrade FA3’s confidence/support.
- **FA8 also uses invalid evidence.** Same problem: `0117` is tooling/parser failure, not a model behavior.
  - **Change:** drop “parser/tooling artifacts” from FA8 and from prompt item 10.
- **Playwright path is imprecise in the report.** The config is `packages/codev/playwright.config.ts`, not repo-root `playwright.config.ts`.
  - **Change:** name the full path or say “Playwright config exists in the repo.”

**Bias concerns**
- **Pattern 9 is over-weighted.** It is single-investigator and still promoted into the TL;DR top 8 as co-equal with consensus patterns.
  - **Change:** merge TL;DR tip 8 into Pattern 1 as a sub-bullet: “For validation surfaces, enumerate empty/NaN/conflicting/unknown inputs.”
- **Pattern 10 is too generic for a “universal Codex-derived pattern.”** Three projects is threshold-only, single-source, and the advice reads like general security hygiene rather than a distinctive Codex pattern.
  - **Change:** demote Pattern 10 to a short “watchlist / lower-confidence” appendix instead of a numbered core pattern.
- **FA8 is under-justified.** After removing the invalid `0117` evidence, it falls below threshold and overlaps FA6.
  - **Change:** merge FA8 into FA6 and collapse prompt items 1 + 10.

**Suggested changes**
- **Report:** replace “22–23 distinct projects” with an exact count.
- **Report:** in “Disagreements and resolution,” change Pattern 9 resolution to:  
  `Merged into Pattern 1 in TL;DR; retained as a sub-pattern in details due strong evidence but single-investigator support.`
- **Report:** change Pattern 10 heading to:  
  `Watchlist: security hardening checks [lower-confidence, 3 projects, single-investigator]`
- **Prompt item 1:** change “Grep before claiming…” to  
  `Search the repo/context before claiming code or tests are missing…`  
  (“grep” assumes a tool path the consult may not have.)
- **Prompt item 5:** keep the porch warning, but remove over-specific mechanics:  
  replace `phase: in_progress and build_complete: false change automatically after porch done...` with  
  `pending gates and porch-managed status fields are orchestration state, not by themselves deliverable gaps.`
- **Prompt items 1 + 10:** merge into one:
  - `**Repo-visibility limits.** You may be reviewing changed files before commit, not the entire committed tree. Missing from diff, untracked, generated, or skeleton-only files are not defects by themselves; first confirm they affect committed, shipped behavior.`

**Verdict**
- **`codex-request-changes-patterns.md`** — **REQUEST_CHANGES**
- **`codex-false-alarm-prompt.md`** — **REQUEST_CHANGES**

**Must-fix vs nice-to-have:** must fix the invalid 0117 evidence, corpus-count ambiguity, and project-specific prompt wording; nice to have is re-ranking/demoting single-source patterns.