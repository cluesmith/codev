## PR Strategy

**Do not autonomously open a PR per implementation phase.** Plan phases ship as git commits within a single PR, not as separate PRs. The plan's instruction that "each phase commits independently" refers to git commits, not PRs.

By default, the PR is opened during/after the final implement phase, with all phase-commits already on the branch.

### Architect-requested PRs

The architect MAY request a PR at any point — for spec review, mid-implementation feedback, slicing a large spec into shippable PRs, etc. When the architect explicitly asks for a PR earlier (or for additional PRs), follow that direction. The prohibition is specifically on the *builder* autonomously deciding to open per-phase PRs without architect request.

{{> partials/multi-pr-mechanics.md}}