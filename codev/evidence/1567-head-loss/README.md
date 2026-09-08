# Issue #1567 — delivery-side head loss: repro harness evidence

All runs: a REAL Claude Code TUI (`claude 2.1.263`, `--dangerously-skip-permissions --model
haiku`, 120x40) under node-pty in an empty scratch directory, driven by
`packages/codev/scripts/bugfix-1567-head-loss-harness.mts`. No Tower, no shellper, nothing
under `~/.agent-farm` touched. The frame is built by the production formatter
(`formatArchitectToBuilderMessage`), the production render gate (`classifyBuffer` with
`CLAUDE_PROFILE`) plus the production `SETTLE_BEFORE_WRITE_MS` decide when a write may go out,
and `--mode production` writes through the production edge (`submitMessagePaced`) itself.

Each trial's body starts with a unique HEAD token and ends with a unique TAIL token. A trial is
`head-lost` when the TAIL rendered on the terminal (composer echo or transcript) and the HEAD
never did — the exact shape the issue's specimens describe. Every trial here was injected onto a
gate-clean composer that had been quiet for 8–16 s (the `ms after turn end` column), so none of
these is a just-freed-window race.

## Matrix

| run | write strategy | frame | trials | head-lost | notes |
|---|---|---|---|---|---|
| `baseline-production-…` | **production edge, today** (one `write()` of the whole 3-line frame, Enter +50 ms) | 1172–1174 B / 3 lines | 20 | **14** | the bug. Every lost trial cut at the same point: ~186 B survived, ~988 B lost |
| `threshold800-production-…` | production edge, today | 1000 B / 3 lines | 10 | 0 | frame just UNDER the 1022-byte PTY input-queue limit → never lost |
| `explore-chunked-…` | plain text in ≤512 B writes, 5 ms apart, then Enter | 1172 B / 3 lines | 10 | 0 | no bracket; keeping each write under the queue limit alone is sufficient |
| `explore-bracketed-…` | ONE write `ESC[200~`+frame+`ESC[201~`, Enter +80 ms | 1172 B / 3 lines | 10 | 0 | still one write over the limit — the bracket alone is also sufficient |
| `explore-bracketed-chunked-…` | bracketed AND ≤512 B chunks | 1172 B / 3 lines | 10 | 0 | the belt-and-braces candidate |
| `multiline-cr-…` | bracketed-chunked, newlines as `\r` inside the bracket | 1689 B / 10 lines | 3 | 0 | placard `[Pasted text #N +9 lines]`; transcript keeps every line break |
| `big3k-…` | bracketed-chunked | 3165 B / 3 lines | 3 | 0 | placard `[Pasted text #N +2 lines]`; full text in transcript after Enter |
| `fixed-claude-production-…` | **production edge AFTER the fix** (bracketed paste, ≤512 B chunks, Enter outside) | 1172–1174 B / 3 lines | 20 | **0** | acceptance run; the reply oracle confirms claude received the HEAD token on every trial |
| `fixed-r2-claude-production-…` | production edge after the CMAP round-1 fixes (cap includes markers, marker stripping) | 1172–1174 B / 3 lines | 20 | **0** | re-acceptance after the write shape changed |
| `codex-codex-…` | bracketed-chunked against `codex-cli 0.146.0` | 1172 B / 3 lines | 3 | 0 | codex shows `[Pasted Content 1168 chars]` in its composer, full frame (fences kept) in the transcript |

Each run directory holds `summary.md` (the table plus an ANSI-stripped screen excerpt per trial)
and `results.json` (machine-readable). The baseline directory also keeps the raw PTY byte log
(`pty.raw`, not committed) — the same evidence the issue's forensic comment read.

## What the numbers say

1. **Reproduced on current code: 14/20.** The loss does not need a just-freed composer; an
   idle one eats the head 70% of the time for a ~1.17 KB single-line frame.
2. **The loss unit is the PTY input queue, not the TUI's line count.** Every field specimen is a
   single-paragraph body — a 3-line frame — so they all went out on the single-write path, not
   the >3-line per-line pacing the forensic comment named. The cut point is constant (~988 B lost
   here; ~1016–1022 B by arithmetic on the three field specimens) and a 1000-byte frame never
   loses: the master-side write is split by the kernel at the ~1 KB input-queue high-water mark,
   the recipient TUI reads the first chunk, classifies it as a paste, and discards it (claude's
   `paste again to expand` hint appears on every lost trial), then types the second chunk and the
   Enter normally — the mid-sentence tail-only fragment.
3. **Two independent fixes, both 0/10:** never put more than the queue's worth of bytes in one
   write (chunking), and make the paste explicit so the heuristic never runs (bracketing). The
   fix uses both, for claude and for any harness that might split the read differently.
4. **Echo needle after the fix:** a bracketed frame shows `[Pasted text #N +M lines]` in the
   composer and the full header in the transcript once submitted, so verification accepts a new
   header occurrence OR a new placard occurrence (the latter is what a `--no-enter` send shows).
   codex's placard reads `[Pasted Content N chars]`; both forms are matched.
5. **Gate hardening for the just-freed window (architect item 4)** has no supporting datum in
   this harness — every loss happened ≥8 s after turn end and none was prevented by waiting —
   so no `N` could be measured. Left out rather than invented; see the review doc.

## Reproduce

```bash
cd packages/codev && pnpm build
node --experimental-strip-types scripts/bugfix-1567-head-loss-harness.mts --trials 20   # production edge
node --experimental-strip-types scripts/bugfix-1567-head-loss-harness.mts --trials 10 --mode chunked
node --experimental-strip-types scripts/bugfix-1567-head-loss-harness.mts --trials 10 --mode bracketed-chunked
```
