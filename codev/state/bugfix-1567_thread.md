# bugfix-1567 thread — afx send delivery-side head-loss on long bodies

## 2026-09-08 — investigate

Architect fixed the design in the issue (03:30Z comment): repro harness first (must FAIL on
current code), then bracketed-paste write for long bodies, echo-verify learns the placard,
cheap gate hardening for the just-freed window, keep #1584/#1585 no-rewrite semantics.
Extra constraints (03:31Z afx message): no Tower against production `~/.agent-farm`, tell the
architect before starting any test Tower, messages < 300 chars or a `/tmp/bugfix-1567-msg-NNN.md`
pointer.

### What the write edge does today (read, not assumed)

- `message-write.ts`: frames with < 4 lines go out as ONE `session.write(frame)` then `\r`
  after 50 ms. Frames with ≥ 4 lines go out line-by-line at 10 ms gaps, then `\r` after 80 ms
  (Bugfix #584, tuned against an older claude paste heuristic).
- The builder frame (`formatArchitectToBuilderMessage`) is deliberately 3 lines (header, body,
  footer+reply hint) so a single-paragraph body stays on the single-write path. **Every
  specimen in the issue is a single-paragraph body**, so the truncated sends were single
  ~1.1 KB writes, not the per-line paced path the forensic comment named. The harness tests
  the production edge with the production frame either way.
- Transport has no chunking: Tower → shellper socket frame → `pty.write(payload)` in the
  shellper (`shellper-process.ts:443`) → node-pty master fd. `write()` returning true means
  "socket connected", nothing more.
- #1573 already added settle-before-write (250 ms of output silence), the 48 KB loud limit,
  and header-only echo verification; #1584 made the row commit BEFORE verification, so a
  header-not-seen result is reported (`verified: false`) and never re-written.

### Harness plan (no Tower)

Real `claude` TUI under node-pty in a scratch dir, production `submitMessagePaced` +
`formatArchitectToBuilderMessage` imported from `dist/`, production `SessionScreen` +
`classifyBuffer(CLAUDE_PROFILE)` to detect the clean composer, production settle (250 ms)
before the write. Each trial's injected message asks claude for a one-word reply, so the
reply's turn-end is the trigger for the next trial. Head-intact vs head-lost is judged from
the raw PTY byte log by looking for a unique HEAD token placed at the start of the body.
Evidence lands in `codev/evidence/1567-head-loss/`.

Worktree had no `node_modules`; ran `pnpm install --offline` + build before anything else.

### Smoke run (2 trials, production edge, idle composer) — REPRODUCED

Trial 2 of 2 lost its head: the composer showed only the last ~180 bytes of a 1202-byte frame,
claude's "paste again to expand" hint appeared, and the HEAD token never rendered anywhere in
the PTY log. The composer had been idle ~8 s, so the just-freed window is NOT required.

Lost prefix ≈ 1202 − 180 ≈ 1022 bytes. The same arithmetic on the three field specimens
(frame = header + body + footer; tail = what the recipient reported) gives ~1016–1022 bytes
lost each time. 1022 = TTYHOG − 2, the macOS PTY input-queue high-water mark at which the
master-side write blocks. So the loss unit is the kernel input queue: the first ~1022 bytes
queue up while the writer is blocked, something on the reader side discards the queue, and
the remainder is then read normally. Whether the discard is the TUI's paste handling or a
tcflush is not observable from outside, and the fix does not depend on it: never leave more
than the queue's worth of bytes pending, and make the paste explicit (bracketed) so the TUI's
heuristic never engages.

Harness gained `--mode production|chunked|bracketed|bracketed-chunked` so candidate
strategies are measured against the real TUI before the write edge changes.

### Baseline (20 trials, production edge, ~1000 B single-paragraph bodies) — 14/20 head-lost

`codev/evidence/1567-head-loss/baseline-production-2026-09-08T03-48-25-247Z/`. Every injection
landed ≥ 8 s after the previous turn's last output byte on a gate-clean composer, so the
"just-freed" window is not the trigger. Frame 1172–1174 B, 3 lines → the single-write path.
Reply oracle was noisy in this run (matched the body's own "ZZ followed by"); fixed for later
runs. Candidate strategies (chunked / bracketed / bracketed-chunked) now running 10 trials each.

### Strategy matrix (all against the real TUI; full table in codev/evidence/1567-head-loss/README.md)

| strategy | frame | lost |
|---|---|---|
| production edge today | 1172 B / 3 L | 14/20 |
| production edge today | 1000 B / 3 L (under the 1022 B queue limit) | 0/10 |
| plain chunked ≤512 B, 5 ms gaps | 1172 B | 0/10 |
| ONE bracketed-paste write | 1172 B | 0/10 |
| bracketed + chunked | 1172 B | 0/10 |
| bracketed + chunked, 10 lines, `\r` newlines | 1689 B | 0/3 |
| bracketed + chunked | 3165 B | 0/3 |
| bracketed + chunked → codex 0.146.0 | 1172 B | 0/3 |

Root cause, stated: the single-write path hands the kernel >1022 bytes at once; the PTY input
queue splits the read at its high-water mark; the recipient TUI's paste heuristic classifies the
first chunk as a paste and discards it; the remainder + Enter type normally. Not the >3-line
per-line pacing (every specimen was a 3-line frame), not the just-freed window (idle composers
lose 70%), not the transport (no chunking anywhere; `write()` truth = socket connected).

Fix design (implement phase): frames ≥ 4 lines OR > 256 B go out as one explicit bracketed
paste (`ESC[200~ … ESC[201~`, `\n`→`\r` inside per the VS Code precedent in
`apps/vscode/src/review-queue/queue.ts`), written in ≤512 B chunks 5 ms apart, then a measured
settle, then `\r` as its own write. Short frames keep today's byte-identical single write, so
`--raw` slash commands and short sends are untouched. Per-harness seam keyed on the gate
profile's `app` so a harness can opt out of bracketing. Echo verify accepts a new header OR a
new `[Pasted text #N …]` / `[Pasted Content N chars]` placard. Architect item 4 (turn-end gate
hardening) has no supporting datum — every loss was ≥8 s after turn end — so it is reported
rather than implemented with an invented N.

## 2026-09-08 — fix

Architect (04:05Z) accepted the investigation and approved both deviations: item 4 dropped
(no datum), root cause framed as kernel PTY split (>1022 B) + paste heuristic. Field check is
post-merge via local-install on main; pre-merge acceptance = harness 0/20 through the production
edge + reverted-fix still failing + full suite.

Implemented (`message-write.ts`, `mailbox-delivery.ts`, `mailbox-wiring.ts`; 4 source files,
+186/−52):
- `isLongFrame` (≥4 lines OR >256 B) → `framePieces`: bracketed paste (`ESC[200~ … ESC[201~`,
  `\n`→`\r` inside, ≤512 B UTF-8-safe chunks 5 ms apart, markers never split), Enter as its
  own write +80 ms. Short frames byte-identical to before.
- `WriteStrategy` seam: `writeStrategyForApp(profile.app)` — claude/codex bracketed, agy
  `PLAIN_CHUNKED` (old per-line shape, still chunked). Threaded through
  `DeliveryPorts.writeMessage` (optional 5th param) and `submitMessagePaced`.
- Echo watch counts `PASTE_PLACARD_NEEDLES` (`Pastedtext`, `PastedContent`) alongside the
  header; verify passes on a NEW occurrence of either.
- Docs: agent-farm.md (both trees), arch.md #1574 clause, formatter/test comments.

Tests: new `bugfix-1567-bracketed-paste-write.test.ts` (15 cases; the CONTROL case fails on the
HEAD write edge — verified by swapping the old file in: "expected 1 to be greater than 1", i.e.
one write). Updated 584 / 1313-drop / 1365-serializer tests to the new shape; the 1365 fake
composer now decodes bracketed paste the way a real TUI does instead of the assertions being
weakened.

Acceptance: harness `--mode production` through the FIXED edge → **0/20 head-lost** (`codev/evidence/
1567-head-loss/fixed-claude-production-2026-09-08T04-10-15-094Z/`, reply oracle H1567-n on every
trial). Baseline on the pre-fix edge (same harness, same day) remains the reverted-state evidence:
14/20. Full unit suite: 286 files / 5755 tests green.

## 2026-09-08 — pr

PR #1644. CMAP round 1: gemini APPROVE, claude APPROVE, codex REQUEST_CHANGES. Real findings,
all addressed in the follow-up commit:
- `--interrupt` path (`tower-routes.ts`) now resolves the same per-harness strategy as the
  gated path (agy opt-out was bypassed); two tower-routes tests pin it (claude bracketed, agy
  not). The Spec 403 interrupt test's minimal session double gained the identity fields every
  real PtySession has.
- "No write over 512 B" now holds INCLUDING the bracket markers (body chunked at 512 − 12);
  the CONTROL test asserts the tighter bound.
- A literal `ESC[200~`/`ESC[201~` inside a body is stripped so the frame's own bracket is the
  only one the TUI sees (claude's non-blocking note; one line + a test).
- Orphaned JSDoc around `PASTE_PLACARD_NEEDLES` fixed; FOOTER comment states the real rule.
- Evidence trimmed: exploratory runs keep only their summary tables; baseline + fixed keep
  excerpts and results.json (codex: 6,330 added lines → ~2,400).
Not taken: codex's remark that the placard is generic evidence — it is count-based against a
pre-write sample (same doctrine as the header needle); noted, no change.

CMAP round 2 (codex, general-mode on the worktree diff because Tower's overview cache burned the
GitHub GraphQL quota — #1645): REQUEST_CHANGES on two points, both fixed: (a) `pty.raw` captures
had been tracked by the round-1 `git add <dir>` (contradicting the README) — untracked +
git-ignored, results.json excerpts dropped, fixed-run excerpts trimmed to 3 trials; tracked
evidence ~720 KB → ~110 KB. (b) `framePieces` on a body that is nothing but paste markers
produced the literal text "undefined" — now one empty well-formed paste; test added.

CMAP round 3 (codex, worktree diff): **APPROVE**, no key issues. Final: gemini APPROVE, claude
APPROVE, codex APPROVE. Full suite 5759 green. PR #1644 at the `pr` gate awaiting the human.
