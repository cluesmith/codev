# 1658 review (PR) iteration 3: dispositions

Head reviewed: 2d85e6fd8 (fa7d227e2 plus porch's status commit). Gemini skipped (agy exit 3).

## Codex (REQUEST_CHANGES)
- ConPTY fixtures, the manual pass, and codex / #1858 scope: N/A for the builder. These are declared pr-gate conditions held by the owner.
- Final-head Windows run 39927653580: ADDRESSED. Attempt 1: install guard, install verification, CLI and probes green; unit Node 22 green (7526 passed / 156 skipped); unit Node 24 had one intermittent (spec-1280 T12: measure-prompt-surface.sh exited non-zero once with no stderr). The failed job is rerun as attempt 2, and the PR body now carries the results.

## Claude (COMMENT)
- PR body Testing claim stale: ADDRESSED (updated with the run results).
- POSIX required checks pending: to verify on a stationary head before the gate request.
- HUMAN_HOLD_DETAILS admits composer-redraw, so a held fixture could pass for the ConPTY pathology: ACCEPTED as a pre-emptive item. It lands with the claude fixtures (a per-capture expected detail), because the replay suite has no real captures to apply it to yet.
