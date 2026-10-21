# air-1840 — `afx decisions init`

## 2026-10-19 — implement

- Template lives in `servers/decisions/template.ts` (`DECISIONS_FILE_TEMPLATE`); the doc test pins
  section 4's fenced block to it (`fileSkeleton + '\n' === constant`). Kept the doc's line order
  (`_Status:` then `_Zone:`), which is what #1837 shipped and what the existing test pins — the
  issue lists `_Zone` before `_Status`, read as a list of contents, not an order.
- Command: `commands/decisions.ts`. Resolution and containment reuse `configuredDecisionsPath` +
  `resolveDecisionsPath` from `servers/decisions/file.ts`, so the command and the tab apply one
  rule. The write is `flag: 'wx'`, so an existing file, directory or dangling symlink at the path
  is refused without a check-then-write race.
- `--path` must be relative (same rule as `dashboard.decisionsFile`), so the printed path can go
  into config verbatim.
- Judgment call: when `--path` names a file the tab does not read (it differs from the configured
  path), the command does not claim the tab will appear; it prints the `dashboard.decisionsFile`
  setting that shows it instead. Writing config is not in the issue, so it does not.
- Architect role: kept the section at three lines, as asked, by folding the doc pointer into the
  new sentence.

## 2026-10-19 — PR #1841, CMAP round 1

gemini=APPROVE, codex=REQUEST_CHANGES, claude=COMMENT (first run failed: `consult --type pr` from a
builder needs `--issue 1840`; it could not infer the project).

Fixed:
- codex: the `--path` hint printed `"dashboard.decisionsFile": "…"`, which reads as a flat key; it
  now prints the nested JSON `{"dashboard":{"decisionsFile":"…"}}`.
- claude: an absolute config aborted `init --path`, but a config resolving outside the workspace
  did not. Now any config the tab refuses is refused here too, `--path` or not (fail loud).
- claude: added `### afx decisions init` to the command reference in both trees; the EEXIST message
  no longer claims a directory "holds the owner's rulings".

Not taken: listing the command in the afx skill's "Other commands" block (optional; that list is
already incomplete). `_Status:`/`_Zone:` order kept, which claude agreed with.

## 2026-10-19 — architect review

Architect (main) approved the integration review and asked for one line in the afx skill's
"Other commands" block: added to all four copies (`.claude`/`.codex`, both trees; each pair kept
byte-identical). pr gate stays pending; the architect takes the merge word to the owner.
