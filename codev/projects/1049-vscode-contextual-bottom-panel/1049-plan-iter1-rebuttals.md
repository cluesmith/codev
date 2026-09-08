# Rebuttal — Plan 1049, Plan iteration 1

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude REQUEST_CHANGES** (both high-confidence, source-verified). Plus the **architect's contract-surface review** (4 notes + 1 minor). All findings adopted; several were genuine correctness defects I verified against source before acting. The revised plan re-flags the changed contract surfaces to the architect before the gate.

## Verified before acting

| Claim | Source | Verdict |
|---|---|---|
| Vitest `include` is `['src/__tests__/**/*.test.ts']` (rooted, not recursive) | `apps/vscode/vitest.config.ts:16` | Correct — tests relocated to `src/__tests__/` |
| `tsconfig.json` excludes `src/markdown-preview/webview`; `tsconfig.webview.json` includes only it | both files | Correct — both updated for the new webview dir |
| `DiffInjectSessionEntry.fsPath` is the **right/modified** worktree path; `builderId` is the terminal-lookup id | `diff-inject-codelens.ts:60-64` | Correct — key on `input.modified.fsPath` |
| Webview uses `React.createElement` (no JSX config) | `markdown-preview/webview/main.ts:25,111` | Correct — primitives follow `createElement` |
| `getActiveBuilderId()` keys off the verified terminal map, not a label | `terminal-manager.ts:450` | Correct — cited (architect A3) |

## Architect contract review

- **A1 (BLOCKING) type placement** — the types were already extension-local (`apps/vscode/src/contextual-panel/`); now **stated explicitly** in the Executive Summary and Phase 1 as deliberately not in `codev-types`, with a risk row.
- **A2 worktree-artifact builderId** — adopted and *decided*: a `.builders/<id>/` artifact is `artifact` with `builderId` from the segment, and a derivable builderId **makes Code Review + Builder Inspector applicable, scoped to that builder**. Encoded in the `SurfaceContext.artifact` shape and the applicability rule.
- **A3 terminal identity (#1497)** — cited `getActiveBuilderId()` / `terminal-manager.ts:450` as the verified-map path; no label keying anywhere.
- **A4 webview input validation** — Phase 4 now validates field *values* (`mode ∈ ModeKind`, `builderId ∈` known-builders), not just the message type; invalid → ignore; test added.
- **A5 (minor)** — recorded the one-line rationale for never emitting `{document-review, summary}`.

## Codex (REQUEST_CHANGES)

- **C1 exit proxy incomplete** — added explicit **last-focused-surface** state; `builderTerminal` emitted only while last-focused is the terminal.
- **C2 clearing on every trigger is wrong** — now clears only on a **stable surface-identity transition**; cursor moves / bg-tab / registry refresh that leave identity unchanged do not clear.
- **C3 `SurfaceContext` pre-resolved discriminator** — changed to **independent predicate signals** so the resolver applies precedence and overlap is testable. *(Contract change → re-flagged to architect.)*
- **C4 diff derivation / context keys can't be read back** — derive `builderDiff` from `TabInputTextDiff` / `vscode.changes` + registry lookup on `input.modified.fsPath`; the write-only context key is not the predicate.
- **C5 tests wouldn't run** — relocated to `src/__tests__/contextual-panel-*.test.ts`.
- **C6 tsconfig sync** — Phase 2 updates both configs.
- **C7 manifest `"type": "webview"`** — added.
- **C8 "seven" render targets is six** — plan enumerates the **six** targets and flags the spec's "seven" as a frozen-spec typo for the architect.
- **C9 changelog unassigned** — assigned to Phase 4 deliverable/AC.

## Claude (REQUEST_CHANGES)

- Tests-won't-run, tsconfig-sync, `"type":"webview"`, and the over-broad-context-key precedence violation — all confirming Codex; adopted as above.
- **Diff-side ambiguity** — `input.original` is the `codev-diff:` side; keying there loses `builderId`. Contract now names `input.modified.fsPath`.
- **WebviewView visibility lifecycle** — new: `resolveWebviewView` re-fires on re-show and a hidden webview can't receive messages. Provider now **caches the last `ModeDescriptor` and re-posts on resolve + `onDidChangeVisibility`**; Phase 2 deliverable + AC + manual collapse/reopen check.
- **`panel-placeholder.test.ts` delete, not modify** — corrected; `contributes-panel.test.ts` keeps its sidebar-list + `PANEL_REVEALED_KEY` assertions.
- **Minors** — security escape test now an explicit Phase 3 item; render targets enumerated; view id **decided** (`codev.contextualPanel`; `codev.placeholder` removed) so grep-clean is satisfiable.

## Gemini (APPROVE)

- **tsconfig sync** (= C6) adopted. **DI**: Phase 2 registration injects `extensionUri`, `OverviewCache`, `ReviewQueueStore`, `TerminalManager`.

## Not adopted

- None outright. The one item needing an architect ruling beyond a code fix is **C8** (spec says "seven", the true count is six): the spec is byte-frozen at its approved gate, so I did not edit it; the plan implements the correct six and flags the typo for a possible later erratum.
