# PIR Plan: Second click action on terminal `#N` / `PR #N` — reference into the terminal's agent

## Understanding

Clicking a `#N` / `PR #N` reference in a terminal today has exactly one action: open (in-editor
viewer or browser, per `codev.terminalLinks.issueTarget`). The owner wants a **second action at
the click site** — reference the issue/PR into an agent's prompt, the inject that today lives
only on sidebar rows (*Reference Issue in Architect*) and editor keybindings (`Cmd+K B`/`H`). The
natural site is a builder's or architect's own terminal, where the inject target is
unambiguous: reference into *this* terminal's agent.

Owner's stated intent is **alt-click to reference** (plain click keeps opening). That literal
UX is **not implementable on the stable API** and this is inherited as verified fact:
`TerminalLinkProvider.handleTerminalLink(link)` receives no modifier-key information, and
`TerminalLink` carries no modifier field. The deliverable is the closest achievable UX.

### First task — overlap-picker empiricism (direction a): REJECTED on source evidence

The issue floats direction **(a)**: register a *second* link provider claiming the same `#N`
span so VS Code shows a picker of both links' tooltips on activation. My first task was to verify
that picker empirically, because it is the load-bearing assumption of (a).

I could not click-test inside VS Code from the builder sandbox, so I verified against VS Code's
own source and maintainer record. The finding is decisive: **xterm.js does not support multiple
link providers claiming the same range — there is no overlap picker.**

- microsoft/vscode **PR #135419** (the fix for reused-terminal link registration) states plainly:
  *"xterm doesn't natively support handling multiple overlapping link providers on the same range
  of text ... not supported by xterm at the moment."* Overlapping registrations there produced
  **broken** links, not a picker.
- `terminalLinkManager.ts` resolves a clicked link through a single opener keyed by link type, and
  link detectors/providers are ordered by **xterm registration priority** — one link wins the
  cell, activated directly, with **no disambiguation UI**.

Direction (a) is therefore off the table: two providers over the same `#N` span would not yield
*Open* / *Reference* choices; behaviour would be one-wins-or-broken. (If the platform someday
exposes modifiers, literal alt-click becomes a follow-up on the bundled `codev-ide` build — same
reasoning as the #1534 direction-(c) note.) This was flagged to the architect; a live
owner-environment scratch-repro can be prepared on request, but the maintainer PR is
authoritative.

## Proposed Change

Adopt a **refined direction (b)**: keep the single existing `IssueRefTerminalLinkProvider`, and
branch inside its `handleTerminalLink` on the clicked terminal's **agent identity**, so the extra
keystroke lands **only in agent terminals** (better than the issue's framing of (b), which taxed
every click including plain shells).

Behaviour by terminal kind (identity resolved from the clicked `context.terminal`):

- **Non-agent terminal** (shell / dev / any un-managed terminal): open directly — exactly today's
  behaviour, zero change, no reference row. Satisfies "non-agent shells → open only".
- **Builder terminal**: show a QuickPick with two rows:
  1. **Open #N** (issue viewer/browser/PR page, per current logic) — listed **first** so a plain
     Enter fires it (keyboard-first, #797 lineage; the common case stays one extra keystroke and
     no mouse travel).
  2. **Reference #N in `<builder-name>`** — inject the reference into *that* builder's prompt.
- **Architect terminal**: same QuickPick; the Reference row injects into *that* architect
  (`injectArchitectText` with the resolved name), row 1 still Open.

The reference text is built with the existing `buildArchitectReferenceInjection(number, title)`
(it already backs both issue and PR sidebar injects and emits `#N "title" ` / `#N ` — no "PR"
prefix, so issue and PR references are consistent). Title is fetched best-effort at click time via
the same forge client `openTerminalRef` already uses; on any miss it falls back to `#N ` (the
helper's own fallback). The inject **never auto-sends** — final Enter is the human's, everywhere.

### Where the terminal identity comes from

`handleTerminalLink(link)` receives only the link, not the terminal — but `provideTerminalLinks`
*does* receive `context.terminal`. So, exactly as `ReconnectLink` already does, the link object
captures `terminal: context.terminal` at detection time; the handler resolves identity from it at
click time (deferred, so there is zero per-render cost).

Resolving `vscode.Terminal → agent identity` requires reading `TerminalManager`'s private
`terminals` map, so a small **additive read-only** method is added. Shape pinned by the architect:
it takes the terminal as an argument (the *clicked* `context.terminal`, **not**
`vscode.window.activeTerminal`), and recovers identity from the map keys exactly as the existing
`getActiveBuilderId` does — the two near-precedents `getActiveManagedPty` /
`getActiveBuilderId:466` both linear-scan the same map but are hardwired to `activeTerminal`, so a
terminal-arg variant is genuinely needed:

```ts
// terminal-manager.ts — additive at class end; no change to existing methods.
// Same "linear scan over the (≤ maxTerminals) map — no reverse index to keep
// in sync" precedent as getActiveManagedPty / getActiveBuilderId; keyed off the
// map key + ManagedTerminal.type, the same identity the open path was given.
type AgentTerminalTarget =
  | { kind: 'architect'; name: string }  // key: `architect:<name>`
  | { kind: 'builder'; id: string };     // key: `builder-<id>`

agentForTerminal(t: vscode.Terminal): AgentTerminalTarget | undefined {
  for (const [mapKey, entry] of this.terminals) {
    if (entry.terminal !== t) { continue; }
    if (entry.type === 'architect' && mapKey.startsWith('architect:')) {
      return { kind: 'architect', name: mapKey.slice('architect:'.length) };
    }
    if (entry.type === 'builder' && mapKey.startsWith('builder-')) {
      return { kind: 'builder', id: mapKey.slice('builder-'.length) };
    }
    return undefined; // dev / shell → open only
  }
  return undefined;   // un-managed terminal → open only
}
```

This uses the same identity source the manager already trusts (map key + `ManagedTerminal.type`),
so it stays single-source-of-truth. **terminal-manager.ts is architect-fenced** (pir-1563 touches
it for cycling), so per the architect: this lane makes **no** refactor of `getActiveManagedPty` /
`getActiveBuilderId` onto the new method — collapsing the three scans onto one shared helper would
triple the merge surface against pir-1563 for zero feature value. That collapse is noted here as a
**one-line candidate for a later cleanup pass**, not done here. The architect is notifying
pir-1563's owner of the additive touch.

## Files to Change

- `apps/vscode/src/terminal-manager.ts` — **add** `agentForTerminal(t)` (read-only reverse lookup,
  terminal-arg) and export the `AgentTerminalTarget` type. No change to existing methods; no
  refactor of `getActiveManagedPty` / `getActiveBuilderId` (later-cleanup candidate only).
- `apps/vscode/src/terminal-link-provider.ts`
  - `IssueRefLink` gains `terminal: vscode.Terminal` (captured in `provideTerminalLinks` from
    `context.terminal`, mirroring `ReconnectLink`).
  - `IssueRefTerminalLinkProvider` constructor also takes `terminalManager` (alongside
    `connectionManager`).
  - `handleTerminalLink`: resolve identity via `agentForTerminal`; shell → `openTerminalRef`
    directly (unchanged path); agent → `showQuickPick([Open, Reference])`, Open first, then either
    `openTerminalRef` or the reference-inject path.
- `apps/vscode/src/commands/open-terminal-ref.ts` — add a small exported helper
  `referenceTerminalRefInAgent(connectionManager, terminalManager, ref, target)` that fetches the
  title best-effort, builds the text via `buildArchitectReferenceInjection`, and calls
  `injectArchitectText` / `injectBuilderText`. Keeps resolution logic beside `openTerminalRef`
  (its sibling), not in the provider.
- `apps/vscode/src/extension.ts:1547-1549` — pass `terminalManager` into the
  `IssueRefTerminalLinkProvider` constructor at registration.
- Tests (see Test Plan) — unit coverage for the new reverse lookup, the branch decision, and the
  reference-text build; no auto-send.

No Tower surface, no `codev-types` change, no new command, no `package.json` contribution. The
QuickPick is purely runtime UI.

## Risks & Alternatives Considered

- **Risk: QuickPick on every agent-terminal click feels heavy.** Mitigation: Open is row 1 and
  Enter-fast, so the common case is one keystroke with no mouse travel; shells are untouched. This
  is the accepted cost of the API having no modifier channel.
- **Risk: title fetch latency before the QuickPick / inject.** Mitigation: the QuickPick opens
  immediately (rows don't need the title); the title is fetched only on the Reference branch,
  best-effort, with `#N ` fallback — mirroring `openTerminalRef`'s own single-fetch discipline. No
  blocking spinner is added to the pick itself.
- **Risk: terminal-manager.ts fence collision with pir-1563.** Mitigation: additive-only method at
  class end; flagged to architect; code held pending confirmation.
- **Alternative (a) — second overlapping provider:** rejected — xterm has no overlap picker
  (evidence above).
- **Alternative (c) — `issueTarget: reference` setting:** rejected in the issue — it *replaces*
  open rather than *adding* a choice.
- **Alternative — literal alt-click:** impossible on the stable API (no modifier in the callback).
- **Alternative — reference into the *active* terminal rather than the *clicked* one:** rejected —
  the clicked terminal is the unambiguous target; capturing `context.terminal` binds the action to
  the terminal the user actually clicked, matching `ReconnectLink`'s precedent.

## Test Plan

**Unit (vitest, `apps/vscode/src/__tests__/`):**
- `agentForTerminal`: architect terminal → `{kind:'architect',name}`; builder terminal →
  `{kind:'builder',id}`; dev/shell terminal → `undefined`; un-managed terminal → `undefined`
  (fake `terminals` map with stub `vscode.Terminal` objects).
- Reference-text build: reuses `buildArchitectReferenceInjection` — assert issue and PR both emit
  `#N "title" ` and fall back to `#N ` with no title (existing helper tests cover the escaping;
  add a case asserting the terminal-ref path routes through it).
- Handler branch (provider-level, stubbing `terminalManager` + `connectionManager`): shell target
  → calls `openTerminalRef`, never injects; builder target with "Reference" picked → calls
  `injectBuilderText(id, text)` and **not** with a trailing newline (no auto-send); architect
  target → `injectArchitectText(text, name)`; "Open" picked → `openTerminalRef`, no inject.
- `IssueRefLink` carries `terminal` from `context.terminal` in `provideTerminalLinks`.

**Manual (needs the owner's VS Code environment — the interaction UX is the feature):**
- In a **builder** terminal, click a `#N`: QuickPick shows *Open #N* (row 1) and *Reference #N in
  `<builder>`*; pick Reference → `#N "title" ` lands **unsent** in that builder's prompt; pick
  Open (or Enter) → issue opens as before.
- In the **architect** terminal, same flow → reference lands unsent in the architect prompt.
- In a **non-agent shell** terminal, click a `#N`: opens directly, **no** QuickPick (negative
  case).
- `PR #N` in a builder terminal → Reference injects the PR reference text, unsent; Open opens the
  PR page.
- Confirm no click path ever auto-sends (no trailing Enter).

**Evidence for dev-approval:** the four manual flows above must be *seen running* — the click in a
real builder terminal and the architect terminal, the reference landing unsent in the correct
prompt, and the non-agent-shell open-only negative case. These need Amr's environment (live Tower +
agent terminals); I will name them explicitly at the gate.

**Consultation:** CMAP (3-way) after implementation code and after tests, per house rule.
