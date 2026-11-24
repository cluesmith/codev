# Phase 5 (`cockpit_actions`), iteration 1: responses to the reviews

Codex: APPROVE, no key issues. Claude: APPROVE, four non-blocking notes. I checked each note
against the code before acting on it.

Both lanes warned that `codev/state/spir-1963_thread.md` changed during the review. That was me:
I appended the architect's Phase 5 rulings while the lanes ran. No reviewer wrote to the tree.

## Claude

### 1. The parity guard's source-view filter was anchored: fixed

The claim holds. `SOURCE_VIEW` matched only a `when` clause that *starts* with
`view == codev.{workspace,agents,tower}`. A future entry such as
`codev.hasFoo && view == codev.agents` would have escaped both the oracle and the 18/9 counts.
Today no entry is written that way, which is why nothing failed.

**Fixed:**
- the filter now matches the view clause anywhere, at a word boundary;
- the Cockpit filter matches the same way;
- a new test pins the behaviour: a non-leading clause matches, a parenthesised one matches,
  `codev.agentsExtra` does not, and `codev.cockpit` does not.

The counts are unchanged (18 row entries, 9 title-bar entries).

### 2. `codev.cockpit.openWebInterface`'s hidden palette entry had no test: fixed

The claim holds. The parity test reads only `view/item/context` and `view/title`. A new test
asserts that the command is contributed and that its only `commandPalette` entry is
`when: "false"`.

### 3. The root listing awaits the worktree-config fetch: kept, as the plan prescribes

The plan specifies this: the Cockpit "resolves the config once, in its async root `getChildren`",
because rows are built synchronously in `getTreeItem` and need the config for the current row's
context value. I checked how bad the exposure is.

**The fetch cannot reject.** `loadWorktreeConfig` returns `null` when not connected.
`TowerClient.getWorktreeConfig` returns `null` on any failure, and the SDK `request` catches
everything under a 10 s `AbortSignal.timeout`. So a held request never poisons later renders, and
the worst case is one wait of at most 10 s per workspace path while Tower hangs.

**The suggested alternative has its own cost.** Fetching off the render path, then refreshing when
it lands, renders the current row once without its dev affordances and then re-renders it. The
same dev row would flicker on every load. I prefer the planned design while the exposure stays
this bounded.

**Recorded for the review doc:** a fetch that fails while connected holds `null` until the next
`codev-config-updated`, state change or path change. Until then the current row shows no dev
affordances, whereas the Workspace view refetches on its next render.

### 4. Remove Architect on a row kept only as a builder's owner: kept, recorded

The claim holds, and the harness shows it. After *web* is removed, `WEB (1)` stays as #103's owner
(`architectGrouping`: "no builder is ever dropped") and keeps the `cockpit-architect-sibling`
value.
- **What happens if it is invoked again:** it asks Tower to remove a name Tower no longer has, which
  fails visibly. Nothing is destroyed.
- **Why it stays:** the plan accepts this divergence explicitly. The Cockpit's architect rows come
  from the overview, as the Agents architect axis does, not from the Workspace view's live
  terminals.
- **Where it is recorded:** in the thread now, and in the review doc as a candidate refinement:
  give a row whose architect is not in the overview's roster its own context value, with no
  *Remove Architect*.

### 5. `entryOfRow`'s throw and the placeholder file rows: no change

Agreed with the reasoning. The throw is my Phase 3 decision and is tested. Placeholder file rows
are leaves that nothing reveals.

## Plan wording vs behaviour: Approve Gate

The plan says the Cockpit's Approve Gate is verified "through the stubs" as `porch approve`. Since
#1494 the button relays the human's decision to the builder's spawning architect through Tower's
`POST /api/send`. It runs `porch approve` itself only when no architect is live. The harness
asserts what actually happens, for #101, whose architect `main` is live:
- one `/api/send`;
- no porch call;
- the "sent … to main" notification.

The architect agreed (2026-11-24T11:01Z) that asserting the real behaviour is correct.
