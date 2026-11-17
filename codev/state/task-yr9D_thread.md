# task-yr9D — landing PR #1634 (issue #1473) as maintainers

Mohid (mohidmakhdoomi) authored PR #1634 on `builder/pir-1473`. Owner decision 2026-09-08:
maintainers finish it. **His commits and authorship stay intact — never rebase, never squash,
never force-push.** I merge `origin/main` in and add commits on top; the architect handles all
communication on the PR thread.

## 1. Merge of origin/main — done (`9788b2f2a`)

79 commits behind. Two conflicts, both from PR #1644 (issue #1567 — long frames go out as one
bracketed paste in ≤512-byte chunks, Enter outside the bracket).

**`message-write.ts`**, two hunks:

- The interface region. #1473 added `PacedWriteSession` (`id`, `inputSeq`, `write(data,
  origin?)`) directly above the #584-era constants `PACED_WRITE_LINE_THRESHOLD` /
  `INTER_LINE_DELAY_MS` / `PACED_ENTER_DELAY_MS`; #1567 deleted exactly those constants and
  replaced them with `BRACKET_MIN_LINES` / `BRACKET_MIN_BYTES` / `PASTE_CHUNK_*` /
  `PASTE_ENTER_DELAY_MS`. Resolution: keep the interface, drop the constants. Nothing
  references the old names any more.
- The write call inside `trySubmitToSession`. Both sides edited the same two lines for
  unrelated reasons — #1473 samples `inputSeq` there (it must be read INSIDE the lock,
  immediately before the first byte, or the comparison spans the lock wait too), #1567 forwards
  the `WriteStrategy`. Both kept.

**`mailbox-delivery.ts`**, one hunk — the delivered-unverified block. #1473 moved the whole
escalation OUT of `if (echo)` and generalised it over `UnverifiedCause` (`input-raced` |
`no-echo`); #1567 stayed inside the echo block and only reworded the log line, because a long
frame now shows as a paste placard so "the header never appeared" is no longer the whole
condition. Resolution: #1473's structure, with #1567's wording folded into the no-echo branch
of the message (`neither its header nor a paste placard appeared`).

Everything else auto-merged, and the two integration points read correctly afterwards: the
strategy threads through `DeliveryPorts.writeMessage` from `writeStrategyForApp(profile.app)`,
and `watchEchoOnScreen` counts `PASTE_PLACARD_NEEDLES` alongside the header needle.

`pnpm -r build` green. Full suite green: **294 files / 5932 tests / 48 skipped / 0 failures**.

## 2. Review fixes on top

The 3-way integration review's verified findings, three commits.

**`ba4153bb6` — doc claims vs coverage (Codex, REQUEST_CHANGES).** Both agent-farm.md copies
claimed a held message "cannot fuse with a half-typed draft" without qualification, and arch.md
contradicted itself (§2b: input is observed; §5: the raw write route and human keystrokes are
"both deliberately uncovered", #1473 pending). I traced every writer before rewriting either:

| Writer | Reaches `PtySession.write()`? | Observed |
|---|---|---|
| Browser xterm (`Terminal.tsx` → WS → `handleUserInput`) | yes, default `'external'` | ✅ |
| VS Code webview (`terminal-adapter.ts` → the same WS) | yes | ✅ |
| `POST /api/terminals/:id/write` | yes, comment says the origin is deliberately default | ✅ |
| ungated `--interrupt` / `--escape` | yes (one-arg `write`) | ✅ |
| gated mail delivery | yes, origin `'delivery'` | deliberately NOT counted |
| **`afx attach`** | **no** — `ShellperClient` → shellper socket, DATA frames | ❌ |

So the remaining true gap is `afx attach`, and only in the pre-echo window: once the app echoes,
the output-side classifier sees the draft normally. Both docs now say that. The same correction
went into `terminal-replies.ts`'s header, which listed attach among the clients the server-side
reply filter covers — it is not in scope either way.

**`c4048f787` — the xterm pin (Codex, REQUEST_CHANGES).** `@xterm/xterm` is only a
*devDependency* of packages/codev; `apps/web` declares its own and is the bundle that emits every
reply the table was enumerated from. pnpm gives each workspace its own symlink into the store, so
a bump confined to apps/web would leave the table stale with the suite green. The guard now
asserts both resolutions. Verified the two `createRequire` roots really do resolve independently
(they agree today only because both declare `^5.5.0`).

**`03383afaf` — vocabulary and silent behaviour (Claude, non-blocking).** `hold-verdict.ts`'s doc
still listed three gate details; added `recent-input` on the self-clearing side. Reworded
`busy:recent-input` everywhere it is described (`inbox.ts`, `db/types.ts`, `types/src/api.ts`,
both agent-farm.md copies) — "a keystroke or click" understates it, since an ungated
`--interrupt`/`--escape` moves the same counter. `inbox-cli.test.ts` pinned the old phrase, so
its assertion moved with the wording. Plus two comments in `terminal-replies.ts`: the filter is
chunk-local (a reply split across two `write()` calls under-strips — the fail-safe direction),
and a bracketed paste always carries ESC so it defeats the `includes('\x1b')` short-circuit and
runs every pattern over the full payload (noted, not guarded).

Out of scope by the architect's instruction, both follow-up issues: implementing `afx attach`
observation, and removing `isUserIdle()`.

Suite after the fixes: **294 files / 5933 tests / 48 skipped / 0 failures**.

## 3. CMAP on the diff-on-top-of-Mohid

Reviewed my own commits only (the merge's `--cc` diff plus everything after it) — the PR itself
was already 3-way reviewed twice.

- **Gemini — APPROVE.** Independently re-derived the three merge questions and confirmed all
  four writer-observation claims.
- **Codex — REQUEST_CHANGES**, two blocking, both on my new wording rather than the merge:
  1. "every write … bumps an input counter" is false. `PtySession.write()` runs
     `stripTerminalReplies` first and only records what survives, so a chunk that is nothing but
     a DA/DSR/CPR answer moves neither signal. I had replaced one overclaim with another.
     Fixed in both agent-farm.md copies and `db/types.ts`.
  2. The xterm pin comment called apps/web "the terminal a human actually types into". The VS
     Code integrated terminal is a second typing surface, and ITS replies come from VS Code's
     own bundled xterm, which no test here can pin. Reworded to "the emitter whose version this
     repo controls", naming the unpinnable residual.
- **Claude — APPROVE** with one pre-merge item and four notes. All taken:
  - The flat "can't corrupt a half-typed draft" claim also ships in
    `codev-skeleton/templates/CLAUDE.md` + `AGENTS.md` — the first docs an adopter's agent
    reads. I had grepped for the agent-farm.md sentence and missed the differently-worded twin.
    Fixed in both (they stay identical apart from their by-design header).
  - `send.ts` still said "Someone typed into that terminal" — the same finding (e) overclaim on
    the single most operator-visible surface. Reworded, and `send.test.ts` pinned the old
    phrase, so its assertions moved too.
  - **My (g) comment was wrong about who pays the cost.** The filter runs only for origin
    `'external'`, so a mail delivery's own bracketed paste never reaches
    `stripTerminalReplies` at all — only an EXTERNAL paste (a human pasting into the browser
    terminal, or a `/write` POST) runs the full-payload scan. As written, a reader would have
    concluded every long send pays it. Corrected.
  - `PacedSubmitResult`'s `racedByInput` doc still described the per-line era's failure modes.
    Inside a bracketed paste a `\r` is literal, so a human's Enter cannot submit early — it is
    absorbed INTO our body instead. Added the strategy-dependent shape and the window it
    shrank (`99×10+80` ≈ 1,070 ms per-line vs `(chunks−1)×5+80` bracketed).
  - `hold-verdict.ts` said the composer "is empty" during `recent-input`; it was last
    *classified* empty, which is the whole point of the hold. Softened.

Nobody found a problem with the merge resolution itself — all three verified the `inputSeq`
sample sits inside the lock, that no #1567 behaviour was lost, and that the deleted constants
have no live references.
