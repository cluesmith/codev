# Spike: afx send input corruption — line-occupancy detection & non-destructive delivery (#1265)

**Date**: 2026-07-30

**Verdict**: **Feasible** — the recommended combination (A+E core, H for max-age, per-app atomic delivery) is validated empirically against both target TUIs, with one significant revision: **Option I is app-specific** (claude wants the *unbracketed* atomic form, codex the *bracketed* one — each fails with the other's form), and the issue's proposed composing clear-set was wrong on two keys (ESC, Ctrl+G).

## Question

Issue #1265: `afx send` can land in the middle of a half-typed draft and submit the blob as one message, because the defer decision uses a 3s idle timer (`isUserIdle`) instead of real line-occupancy. The issue proposes options across detection (A/E/F/G), delivery (B/C/H/I/J), and channel (D/K/L) axes, recommending **A+E** core, **H** for the 60s max-age case, **J** framing, **I/K** hardening. This spike answers the empirical unknowns analysis could not settle, **against the real Ink-based TUIs** (Claude Code 2.1.212, Codex 0.145.0), and gives a go/no-go per building block.

Method: a node-pty + `@xterm/headless` harness (`codev/spikes/1265-poc/`) spawns the actual `claude`/`codex` binaries, injects keystroke bytes exactly as Tower's `session.write()` does, and asserts on the *rendered* composer. Evidence tags (`b3`, `p4`, …) refer to the `exp-*.cjs` experiments there; `p*` tags are the end-to-end max-age sequence (`exp-i5-maxage-fullseq.cjs`, added after review flagged the kill-ring interaction). Submission-heavy tests ran claude against an unroutable `ANTHROPIC_BASE_URL` (full submit mechanics, zero API calls). Codex ignores base-URL overrides under ChatGPT OAuth, so codex submissions used only the local `/status` command (plus three accidental tiny prompts, lesson learned below).

## Per-option verdicts

| Option | Verdict | Evidence |
|---|---|---|
| **A** — fixed `composing` occupancy | **GO (revised)** | Clear-keys differ from the issue's proposal; see classification table. With the corrected lifecycle the #492 stuck-true scenarios (Ctrl+C, arrows, Tab) are all resolved or safely conservative. |
| **E** — event-driven flush on submit | **GO** | Delivering **0 ms after the user's Enter** lands clean: the injected message became its own (queued) entry, no concatenation, even while the agent was busy retrying (`e1`). Needs a smarter submit-detector than today's `data.includes('\r')` (see hazards). |
| **H** — draft byte capture + verbatim replay | **GO (the load-bearing result)** | On **both** TUIs, a 3-line draft containing a backspace edit was cleared, a message injected+submitted, and the captured bytes replayed — composer reconstructed **byte-identical** (`h3`, `c4`; full end-to-end max-age sequence re-verified in `p5`). An app-agnostic clear exists: `(Ctrl+E Ctrl+U Backspace) × lines` verified on both (`c2`, `i2c`). Restore is the replay **alone** — the inject step must not end in `^Y` (kill-ring interaction, `p4`). |
| **J** — bracketed-paste framing | **GO for codex / NOT for claude's atomic path** | Required to make atomic delivery work on codex (`i2a`); actively harmful in claude's atomic write (`i3` — draft got submitted). Not a control-char sanitizer: codex neutralizes fully, claude's ESC-in-brackets swallowed following chars (`j3`). |
| **B/C** — kill/yank restore | **GO, single-line only — subsumed by I** | Single-line restore works on both (kill-ring/deleted-text buffer real). Ctrl+U kills only the current line of a multi-line draft (confirmed both, `b4`) — multi-line restore impossible, exactly as the issue said. |
| **I** — atomic single-write | **GO, per-app forms — single-line drafts only** | claude: `^E ^U <msg> \r ^Y` as ONE write works for single- AND multi-line *messages* (`b3`, `i4`); bracketed variant FAILS (`i3`). codex: unbracketed FAILS (`\r` becomes newline, `b3`-codex); bracketed variant works (`i2a`). Atomicity genuinely closes the race: a user byte 5 ms later appended cleanly after the restored draft. ⚠ The trailing `^Y` is the *single-line-draft restore* — chained after H's per-line clear it duplicates the first draft line on both TUIs (`p4`); the H path uses the same forms **minus `^Y`** (`p5`). |
| **F** — DSR cursor probe | Not tested | Superseded: H's draft buffer gives a better signal than cursor column; no need for fragile probe/response parsing. |
| **G** — output-stream line modeling | Not tested | Unnecessary — A+H's input-side model proved sufficient; G remains the fallback if future TUIs break input-side assumptions. |
| **K** — side-channel escalation at max-age | Not tested (no TUI unknowns) | Pure Tower-side; `broadcastMessage` exists. Recommended as the safety valve for *unknown* target apps where the per-app delivery matrix is unverified. |
| **#584 pacing** (context) | **Obsolete on current TUIs** | The Enter-swallow does NOT reproduce on claude 2.1.212 or codex 0.145: a 5-line message in ONE plain write + `\r` after 50 ms submits fine on both (`j1`). Pacing can be retired for known-current agents once this ships (keep as fallback for unknown apps). |

## Baseline corruption reproduced

Today's exact failure reproduced under the harness (`e0`): type `deploy the hotfix to prod once`, pause 3.5 s (`isUserIdle(3000)` → true), deliver today-style (`write(msg)` + `\r` at 50 ms) → one blob submitted:

```
deploy the hotfix to prod once[builder spir-999] tests green, ready to merge
```

(recalled verbatim from claude's history in `e2` — draft and message fused into a single submission).

## Keystroke → occupancy classification (measured)

| Key | Claude Code 2.1.212 | Codex 0.145.0 | Tracker action |
|---|---|---|---|
| printable | occupies | occupies | append to draft buffer |
| bare `\r` | **submits** (composer clears) | **submits** | clear buffer; **flush trigger (E)** |
| `\x1b\r` (Alt+Enter) | newline in draft | newline in draft | append newline — **NOT submit** |
| `\n` (Ctrl+J) | newline in draft | newline in draft | append newline — **NOT submit** |
| `\\` then `\r` | newline in draft (continuation) | **submits** (`ccc\` went to the model) | treat as non-submit (safe direction: worst case is deferral, not corruption) |
| Ctrl+U | kills whole current line | kills whole current line | drop current line from buffer |
| Ctrl+C | clears draft (⚠ arms exit when line already empty — unsafe as an *injected* primitive) | clears draft | clear buffer |
| ESC ×1 | nothing ("Esc again to clear") | nothing | no-op |
| ESC ×2 | clears draft (⚠ opens rewind/queued-edit overlays when composer empty) | does **NOT** clear | app-dependent — unusable as a portable clear |
| **Ctrl+G** | **opens $EDITOR (vim) with draft** | **same** | ⚠ modal — must NOT be in any clear-set (issue proposed it; wrong) |
| Up | occupies (history/queued recall, `e2`) | occupies — recalls even **cross-session persisted** input | mark composing (genuinely occupies) |
| Down | may return to empty | may return to empty | keep composing (conservative) |
| Tab | hint only, line unchanged | line unchanged | neutral — do not set composing (was a #492 stuck-true source) |
| Left/Right | cursor only | cursor only | neutral |
| Backspace | may empty the line | same | drop last char from buffer (buffer-empty ⇒ not composing) |

**Key insight that simplifies the design**: H's per-session **draft byte buffer subsumes A's boolean**. Occupancy = "draft buffer non-empty" (with Up/Down marking a conservative `dirty` flag). One `DraftTracker` in the websocket input path powers all three: the defer decision (A), the flush-now event (E: buffer transitioned to empty via `\r`/Ctrl+C/Ctrl+U), and the replay payload (H).

## Submit-detector hazards (for E)

Today's `tower-websocket.ts:96` heuristic (`data.includes('\r') || data.includes('\n')` ⇒ stopComposing) is wrong in both directions:
- **False submit** (would flush mid-draft — the corruption we're fixing): Alt+Enter frames (`\x1b\r`), Ctrl+J (`\n`), backslash-continuation `\r` (claude), and `\r`/`\n` inside bracketed-paste content (user pasting a multi-line draft).
- Correct rule: submit ⇔ frame is bare `\r` (or `\r` not preceded by `\x1b` in-frame, not inside `ESC[200~…201~`, previous frame not ending in `\\`). Kitty-protocol Enter (`\x1b[13u` style, if a client terminal ever sends it) should also be matched; missing it only degrades to max-age deferral (safe direction).

## Delivery matrix (for the max-age / busy-line path)

Two **non-overlapping** paths, selected by whether the captured draft is single- or multi-line. The trailing `^Y` is the *single-line restore mechanism* and must appear **only** there — on the multi-line path the byte-replay is the restore, and a trailing `^Y` measurably corrupts it (see the kill-ring constraint below and `i5`).

**Single-line drafts — kill/yank restore (Options I/B). Form ENDS in `^Y`:**

| Target | Verified atomic form | Result |
|---|---|---|
| claude | `^E ^U` + msg (raw, multi-line msg ok) + `\r` + `^Y` — one write | message submitted intact, draft restored by the yank, user bytes cannot interleave (`b3`, `i4`) |
| codex | `^E ^U` + `ESC[200~` msg `ESC[201~` + `\r` + `^Y` — one write | same (`i2a`) |

**Multi-line drafts — H byte-replay restore. NO trailing `^Y` anywhere:**

| Target | Verified sequence | Result |
|---|---|---|
| claude | per-line clear `(^E ^U BS) × N` → `^E ^U` + msg + `\r` (one write, **no `^Y`**) → byte-replay | draft reconstructed byte-identical (`p5`, claude) |
| codex | per-line clear `(^E ^U BS) × N` → `^E ^U` + `ESC[200~` msg `ESC[201~` + `\r` (one write, **no `^Y`**) → byte-replay | same (`p5`, codex) |
| unknown app | per-line clear → kill + bracketed msg in one write, `\r` after ~50 ms (**no `^Y`**), then replay | verified shape on both (`i2b`, `j2`); residual ~50 ms window — close it by continuing byte-capture during the maneuver and replaying late arrivals, or escalate via **K** instead of injecting |

On the multi-line path, N comes from the captured buffer's newline count + harmless slack rounds (extra Backspace on an empty composer is a no-op). The kill/yank restore is off the table for multi-line (`b4`: `^U` kills only the current line). Tower controls the whole sequence, so any user byte arriving mid-maneuver is captured and appended to the replay — the race is closed at the protocol level, not by timing luck.

### Kill-ring interaction (measured — do not re-introduce)

The per-line clear **primes the kill-ring**: it kills bottom-up and consecutive kills **overwrite** (not accumulate) on both TUIs, so after clearing an N-line draft the ring holds exactly the **first draft line** (`p3` ring probe, identical on claude and codex). Chaining the single-line atomic form (which ends in `^Y`) after that clear yanks the stale line onto the fresh prompt before the replay lands — measured outcome on **both** TUIs (`p4`):

```
before:  first line\n  second line\n  third
buggy:   first linefirst line\n  second line\n  third   ← first line duplicated
fixed:   first line\n  second line\n  third             ← no ^Y; byte-identical (p5)
```

There is **no cheap ring neutralizer**: `^U` on an *empty* composer does NOT scrub the ring on either TUI (`p4` still yanked despite the inject form's leading empty `^U`). The fix is structural — the multi-line/H path simply never sends `^Y`.

## Constraints discovered

- **The per-line clear and the trailing `^Y` must never appear in the same sequence.** The clear primes the kill-ring with the first draft line (bottom-up kills, overwrite semantics, both TUIs), a later `^Y` yanks it back ahead of the replay, and no injectable primitive scrubs the ring (empty-composer `^U` doesn't). Duplication measured on both TUIs (`p4`); details in "Kill-ring interaction" above.
- **Per-app divergence is real and version-sensitive.** The bracketed/unbracketed atomicity split (i3 vs i2a) is the sharpest example. Tower knows the configured agent command per terminal — key the delivery form on it, default unknown apps to defer-only + K escalation. Keep the POC harness as a smoke-test to re-verify the matrix when agent versions bump.
- **Ctrl+C is not an injectable clear**: on an empty claude composer it arms "press again to exit" — an injected Ctrl+C adjacent to a user's own could kill the agent (cf. regression #1264). Ctrl+U/Backspace primitives are side-effect-free on both TUIs.
- **Ctrl+G opens `$EDITOR` on both TUIs** — any occupancy design must treat it as modal (set dirty, never clear).
- Codex leaves an **unrecognized `/slash` message in the composer** (with an error) instead of submitting it — a formatted afx message starting with `/` would strand. Current formats start with `[architect]`/`[builder]` so this is only a `--raw` edge; worth a guard.
- Bracketed paste is **not a control-char sanitizer** on claude (ESC inside brackets swallowed following chars, `j3`). Raw control-byte payloads stay on the existing `--raw`/escape path.
- Drafts built via Up-recall replay imperfectly (history mutates once the injected message submits). Edge case; acceptable — or treat nav-dirty drafts as K-escalation candidates.
- Tower must hold draft bytes in memory per session (privacy: never log them; cap the buffer, e.g. 8 KB, falling back to defer-only when exceeded).
- Multi-client sessions (dashboard + VSCode attached to one PTY) interleave input frames; the capture stream is the merged order the PTY itself sees, so replay fidelity holds.

## Recommended approach (confirms the issue's, with revisions)

1. **Core: A+E via a single `DraftTracker`** (websocket input path, `pty-session.ts` or a sibling): draft buffer + dirty flag; defer while non-empty/dirty; flush event the moment the buffer empties (bare-`\r` submit, Ctrl+C, Ctrl+U-to-empty). Replaces `shouldDefer`'s timer-only check (`tower-routes.ts:1570`) and `SendBuffer`'s 500 ms poll (keep the poll as backstop; keep the 60 s max-age valve).
2. **Max-age path, multi-line drafts: H** — per-line clear, per-app atomic inject **without the trailing `^Y`**, verbatim replay (including bytes captured mid-maneuver). The replay is the sole restore mechanism on this path.
3. **Max-age path, single-line drafts: I/B** — the per-app atomic kill/yank form (ends in `^Y`, no per-line clear, no replay). Keep the two paths non-overlapping: `^Y` restores, or replay restores — never both in one sequence (`p4` duplication).
4. **I/J forms**: per-app as specified — J's framing only where verified (codex, unknown-app semi-atomic); never in claude's atomic write.
5. **K**: escalate to `broadcastMessage` + log instead of forced injection for unknown apps / oversized drafts / nav-dirty drafts.
6. Retire #584 pacing for verified-current claude/codex once this ships (keep for unknown apps).
7. Ship the POC harness as a re-verification script for future TUI version bumps.

## Effort estimate

**Medium** (300–1000 LOC): DraftTracker (~150), submit-detector + websocket wiring (~80), defer/flush rewiring in tower-routes/send-buffer (~120), delivery matrix + H maneuver in message-write (~150), K valve (~50), tests (~300, incl. a keystroke-sequence unit suite derived from the classification table). No architectural change — every hook already exists (`composing` plumbing, `SendBuffer`, `noEnter`, `broadcastMessage`).

## Flaky Tests

None encountered (spike ran no repo test suites; all POC runs were against live TUIs).

## Next Steps

- [ ] Create a SPIR spec for the implementation referencing this spike (recommend: DraftTracker A+E core first, H/matrix second phase, K valve third — independently shippable).
- [ ] Decide policy for unknown target apps (defer-only + K vs. semi-atomic injection).
- [ ] Optional: extend the matrix to the Gemini CLI (`agy`) if it becomes a terminal-hosted agent target.

## References

- POC + harness: `codev/spikes/1265-poc/` (this branch; runs need `XTERM_DIR` pointing at a dir with `@xterm/headless` installed — see `harness.cjs` header)
- Issue #1265 (full option analysis); bugfix #450 (composing added), #492 (removed — `8ac64ab1`), #584 (pacing — `36556338`), Spec 403 (typing awareness)
- Code: `tower-routes.ts:1566-1589` (defer), `send-buffer.ts` (flush loop), `message-write.ts` (pacing), `pty-session.ts:548-581` (idle/composing), `tower-websocket.ts:87-132` (input path)
