# pir-1568 — terminal #N/PR ref: second (reference) click action

## Phase: PLAN (2026-09-01)

Issue #1568: add a "reference into this terminal's agent" action to `#N` / `PR #N` clicks in
agent terminals. Owner intent: alt-click to reference. API constraint (inherited as verified
fact): `handleTerminalLink` gets no modifier info.

### FIRST TASK — overlap-picker empiricism (direction a): REJECTED
Could not click-test from the sandbox, so verified against VS Code source instead. Finding is
decisive: xterm.js does NOT support two link providers claiming the same range — there is no
overlap picker. Evidence: microsoft/vscode PR #135419 (maintainer: "xterm doesn't natively
support handling multiple overlapping link providers on the same range of text ... not supported
by xterm at the moment") + terminalLinkManager source (links resolve by xterm registration
priority, one wins, no disambiguation UI). Direction (a) is off the table. Flagged to architect;
offered a live scratch-repro if they still want owner-env confirmation.

### Plan direction: refined (b)
Single `IssueRefTerminalLinkProvider` keeps its span. `handleTerminalLink` branches on the
clicked terminal's agent identity (captured via `context.terminal` stored on the link, resolved
at click time):
- non-agent (shell/dev) terminal -> open directly (today's behaviour; no reference row).
- builder/architect terminal -> QuickPick: row 1 "Open #N" (Enter-fast default), row 2
  "Reference in <agent>". Reference reuses `buildArchitectReferenceInjection` +
  `injectArchitectText`/`injectBuilderText`; never auto-sends.

Extra keystroke lands ONLY in agent terminals — better than the issue's framing of (b).

### Fence: terminal-manager.ts
Need one additive read-only method `identifyTerminal(terminal)` -> architect name | builder id |
undefined. terminal-manager.ts is fenced (pir-1563 touches it for cycling). Flagged to architect;
holding code until they confirm the additive touch is OK.

### Surface
`terminal-link-provider.ts` (IssueRefLink gains terminal; handler branches), a new
`terminal-manager.ts` reverse-lookup method, `extension.ts` registration passes terminalManager
to the provider. No Tower/types surface.
