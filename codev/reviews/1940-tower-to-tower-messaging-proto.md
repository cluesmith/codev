# Review: Messaging between workspaces and between Towers — stage 1 (named architects across workspaces on one Tower)

## Summary

The spec designs messaging in three stages (one Tower; my own Towers; another owner's Tower). The
owner approved it with stage 1 as this project's scope, and this PR builds stage 1: an architect
or a human can write `afx send <workspace>:architect:<name>` to a named architect in another
workspace on the same Tower, the recipient sees who wrote and a reply command that works when
pasted, and `afx workspace list`, `afx workspace name` and `afx whoami` show and manage the
addresses. Six plan phases were built and reviewed; the seventh (a front-door-only setting per
workspace) was cut by the owner at plan approval. No commit in any implement phase went
unreviewed. Stage 2 is issue #1967 (between my own Towers, through Codev Cloud) and stage 3 is
issue #1968 (another owner's Tower, by invitation); each inherits the spec's checklist as written.

## Spec Compliance

The stage 1 checklist in the spec's Success Criteria is this project's acceptance criteria.

- [x] A named architect in another workspace on the same Tower is addressable, and the message is
  delivered or held exactly as a same-workspace message would be, including `no-live-pty`
  (Phase 2).
- [x] Every address form valid before this change resolves to the same recipient as before
  (Phase 1 parser table, Phase 2 resolvers). Text that never reached anyone now fails earlier and
  says what shape was expected: `:agent` and `a:b:c` were a 404 "not found" and are a 400
  `MALFORMED_ADDRESS`.
- [x] A message from another workspace shows the sender's qualified address in its header, and
  its footer says how to reply. Same-workspace frames are unchanged, pinned byte for byte by a
  test committed before the change (Phase 4).
- [x] A builder can name an architect only if it is its own spawning architect, however the
  address is qualified, and reaches every other architect through a front door (Phase 2).
- [x] No reply command in a footer is one the recipient's own send would refuse (Phase 4: each
  printed command is resolved as the recipient by the real resolvers in the tests).
- [ ] A workspace set to front door only refuses mail from outside to its named architects.
  **Not built: cut by the owner at plan approval (decision main-31).** Phase 7 is recorded as
  skipped in `status.yaml`. Nothing in the code or the docs mentions the setting. The default
  (named architects are addressable) and the builder front-door rule are built.
- [x] An ambiguous workspace name fails with an error naming every match and the remedy; giving
  one workspace an explicit address name removes the ambiguity (Phase 3).
- [x] One command lists every workspace on this Tower with its architects, each as an address
  ready to paste; `afx whoami` prints the caller's own address; an explicit workspace name can be
  cleared as well as set (Phase 5 for the listing and whoami, Phase 3 for `--clear`).
- [x] All of the above works on a Tower that has never connected to Codev Cloud, and an `afx://`
  address is refused with a reason that says cross-Tower messaging is not available (Phase 2;
  end to end on a real Tower in Phase 6). The "connected Tower" half is tested at the route
  level only: there is no end-to-end run on a Tower connected to Codev Cloud.
- [x] The address is a structured wire contract in `codev-types`, with one parser and one
  formatter shared by the CLI, Tower and the VS Code extension (Phase 1). One table of cases
  (`packages/types/fixtures/address-cases.json`) is run by all three.
- [x] Docs, skills and role files that teach addressing are updated in both `codev/` and
  `codev-skeleton/` (Phase 6).

### Test scenarios with no test

The spec lists its stage 1 test scenarios; the table at the end of this section maps each to its
tests. Three claims have none. Each with its reason:

1. **The `devvm` hint** ("write `afx://devvm/codev:architect` when `devvm` is one of my Towers").
   A stage 1 Tower has no list of the owner's Towers, so the plan left the hint to stage 2; the
   shape error is given without it, and two tests pin the exact message.
2. **"…until it has an explicit name"**, the second half of two bullets (a workspace whose
   directory is called `arch` or `builder`; one whose directory name has a space). Stage 1
   refuses every `afx://` address, so nothing can show such an address resolving once the
   workspace is named; the refusal half is tested, and the other half is stage 2's.
3. **Front door only** (every claim in that bullet). Phase 7 was cut by the owner.

### Latency

The spec's bound for a same-workspace send is the baseline plus the larger of 5% and 1 ms. The
baseline was taken before any production change (commit `732ad0118`): five runs, medians 4.573,
2.152, 2.121, 2.217, 2.191 ms, so **2.19 ms** and a bound of **3.19 ms**. The machine was busy
(load average 14.6) and the first run was an outlier.

After phase 6 (`fd37af57a`), five runs back to back, 100 timed held sends per scenario per run:

| Run | Same-workspace median | Cross-workspace, named architect, median | Load at start | Load at end |
|---|---|---|---|---|
| 1 | 2.200 ms | 2.215 ms | 5.03 | 5.39 |
| 2 | 2.111 ms | 2.167 ms | 5.39 | 5.16 |
| 3 | 2.270 ms | 2.265 ms | 5.16 | 4.83 |
| 4 | 2.509 ms | 2.506 ms | 4.83 | 5.38 |
| 5 | 2.276 ms | 2.086 ms | 5.38 | 4.91 |

Same-workspace: median of medians **2.270 ms**, inside the bound by 0.92 ms; the worst single run
is inside it too. Cross-workspace to a named architect: **2.215 ms** (the spec sets no bound; for
the record). The baseline was not retaken from a clean copy of the old commit, because the result
was inside the bound. **The comparison is one-sided:** the baseline was measured at a load average
of 14.6 and the after figure at about 5, which favours the after figure. What supports the
conclusion all the same: the measured difference is 0.08 ms against an allowance of 1 ms, and the
cross-workspace figure, which does the extra name lookup, is no higher than the same-workspace
one. Retaking the baseline at a load of about 5 would settle it for the cost of one run of the
old commit; it is listed under Follow-up Items.

### Known boundaries

None of these is changed by this PR. Each was raised in a phase and is recorded here so the owner
sees it at the gate.

- **The unknown-architect hint lists live architects only.** `Architects there: main, tunnel`
  names the architects that have a terminal now. One that is registered and between sessions is
  not in it, though mail to it would be held.
- **A reply command checks permission, not that the sender's workspace is running.** If the
  sender's workspace has stopped, or was never registered with Tower, the pasted command fails
  with the resolver's "not running" or "not found".
- **A stored frame's reply command can go stale.** The frame is written when the message is
  stored. Mail held for a long time, or sent with `--delay`, carries the sender's workspace name
  as it was then; if that workspace is renamed meanwhile, the command fails.
- **With the sender's workspace stopped**, an architect recipient is still offered the sender's
  address (which would fail) while a builder is told to reply through its architect. It cannot
  arise for a message just sent from a running workspace.
- **`from` and `fromWorkspace` are what the sender says.** A local sender can claim any id and
  workspace, as before; the spec treats every local sender as the same owner.
- **A `from` that itself carries a workspace** (`codev:builder-x`) keeps today's frame.
- **Resolver error strings quote a local workspace name that is not checked against the
  component rule.** They go in an HTTP body to the sender's own CLI, never into another agent's
  prompt. Frames, the listing and whoami all pass through one check (`printableAddressName`).
- **The live front door is the terminal map's insertion order.** In a workspace with no `main`,
  an architect terminal that is deleted and registered again moves to the end, so the live front
  door can differ from the registry's until the next workspace start.
- **Workspace routes refuse Windows UNC paths** (`\\server\share\repo`), the new naming route
  included. The check is the line the four existing workspace routes use, so such a workspace
  cannot be started through Tower today either. Issue #1960.
- **A name must fit in an address.** The spec caps an address at 512 characters, so a name whose
  front door `<name>:architect` would not parse is refused when it is set (the architect's
  decision; derived from the parser, no constant of its own).
- **`afx whoami` counts a workspace as running when it has a `terminal_sessions` row** (plus the
  caller's own). A row left behind by a crash counts a stopped workspace as running. The
  architect confirmed this reading.
- **The listing costs about one small query per listed agent**, because each printed address is
  resolved through the real resolvers as the caller. That is deliberate: see Lessons Learned.
- **Two stopped workspaces that share a directory name** are each listed with that name, though
  it would be ambiguous once both run. Both lines read `not running` and list no agents.
- **The older-Tower check asks for the whole address book** on every `NOT_FOUND` of the
  three-part form, an ordinary typo on a current Tower included. Failure path only.
- **`afx whoami` when global.db cannot be opened at all** prints a reason with no remedy.
- **A builder that leaves its workspace out of the request** and writes its own workspace's name
  explicitly is refused. The CLI always sends the workspace; this fails closed.
- Left as they are: no `PUT` in `Access-Control-Allow-Methods` (no browser caller); `quoted()`
  duplicated across the package boundary; the name route reads the name table twice.

### Checked on a real Tower

Phases 3, 4 and 5 were each checked on a built Tower on an isolated port and directory, with a
one-off test that was not committed; phase 6 added the kept one
(`cross-workspace-addressing.e2e.test.ts`, 13 tests, on a Tower asserted never to have connected
to Codev Cloud). The phase 5 transcript is in `codev/state/spir-1940_thread.md`. `<tmp>` is the
test's temp root.

Phase 3, workspace names (two directories both called `codev`):

```
AMBIGUOUS 409 {"error":"AMBIGUOUS","message":"Workspace 'codev' is ambiguous: 2 workspaces have that directory name: <tmp>/a/codev, <tmp>/b/codev. Give one a name of its own by running `afx workspace name <name>` in it."}
[ok] This workspace is now addressed as 'work'.
[info] Another workspace reaches its front door with: afx send work:architect "…"
TO_A 200 {"ok":true,"resolvedTo":"main","deferred":true,"delivered":false,"held":true,"reason":"no-live-pty","detail":null,"bodyLength":5}
TO_B 200 {"ok":true,"resolvedTo":"main","deferred":true,"delivered":false,"held":true,"reason":"no-live-pty","detail":null,"bodyLength":5}
REFUSALS [{"ok":false,"error":"'work' is already the name of the workspace <tmp>/b/codev. (NAME_TAKEN)","errorCode":"NAME_TAKEN"},{"ok":false,"error":"'architect' is a reserved word in addresses and cannot be a workspace name. (RESERVED_NAME)","errorCode":"RESERVED_NAME"},{"ok":false,"error":"'my notes' cannot be a workspace name: use letters, digits, '.', '_' and '-', starting with a letter or a digit. (INVALID_NAME)","errorCode":"INVALID_NAME"},{"ok":false,"error":"Workspace <tmp>/nowhere is not registered with Tower. Start it once first: afx workspace start (NOT_FOUND)","errorCode":"NOT_FOUND"}]
STOPPED 404 {"error":"NOT_FOUND","message":"Workspace 'work' (<tmp>/b/codev) is not running."}
CLEARED {"ok":true,"result":{"explicitName":null,"addressName":null,"unaddressableReason":"it shares the directory name 'codev' with <tmp>/a/codev; give it a name of its own: afx workspace name <name>"}}
```

Phase 4, frames and replies (each frame read from the stored message, each reply sent through
`POST /api/send` as the recipient):

```
SAME    ### [ARCHITECT:main MESSAGE → main | <time>] ###            (same workspace: today's frame, plain footer)
UNNAMED ### [ARCHITECT architect:main (another workspace) MESSAGE → main | <time>] ###
        ###############################  (no reply address; the sender's workspace needs: afx workspace name <name>)
NAMED   200 {"explicitName":"one","addressName":"one"}
CROSS   ### [ARCHITECT one:architect:main MESSAGE → main | <time>] ###
        ###############################  (reply: afx send one:architect:main "…")
REPLY   200, stored for main in <tmp>/a/codev:
        ### [ARCHITECT codev-cloud:architect:main MESSAGE → main | <time>] ###
        ###############################  (reply: afx send codev-cloud:architect:main "…")
TO_BUILDER_FROM_MAIN    ### [ARCHITECT one:architect:main INSTRUCTION → builder-spir-7 | <time>] ###
                        ###############################  (reply: afx send one:architect "…")
BUILDER_REPLY           200, stored for main in <tmp>/a/codev:
                        ### [BUILDER codev-cloud:builder-spir-7 MESSAGE → main | <time>] ###
TO_BUILDER_FROM_REVIEW  ### [ARCHITECT one:architect:review INSTRUCTION → builder-spir-7 | <time>] ###
                        ###############################  (reply through your architect: afx send architect "…")
BUILDER_NAMES_REVIEW    403 REFUSED "builder builder-spir-7 may only address its own spawning architect; reach that workspace through its front door: afx send one:architect "…""
THROUGH_ARCHITECT       200, stored for main in <tmp>/codev-cloud: ### [BUILDER builder-spir-7 MESSAGE → main | <time>] ###
```

This build's CLI against the installed, older Tower (the state right after an upgrade):

```
$ afx workspace list
[error] The running Tower is older than this CLI: it has no address book. Restart Tower to pick up the new version: afx tower stop && afx tower start
$ afx whoami
…
address: none (global.db has not been migrated by a Tower of this version, so it holds no workspace names; restarting Tower migrates it: afx tower stop && afx tower start)
$ afx send codev:architect:nobody-1940 "…"
[error] The running Tower is older than this CLI: it does not know an address of the form <workspace>:architect:<name>. Restart Tower to pick up the new version: afx tower stop && afx tower start
```

The installed `afx send` typed in a real architect terminal against a Tower of this version is
the verify phase's check: no test can point the built binary at a test Tower, because it always
connects to port 4100.

### Scenario-to-test table

Each row quotes a claim from the spec's stage 1 test scenarios and names the tests that check it.
Titles are copied from the source and every one was checked against its file by script. For
`it.each` and `describe.each` tests the title is the source template and the table row is in
brackets; parser rows are named by their `note` in `packages/types/fixtures/address-cases.json`
(`fx N` is the line there). Several tests in one cell are numbered in the same order in both
columns. Test files are under `packages/sdk/src/__tests__/`,
`packages/codev/src/agent-farm/__tests__/` and `apps/vscode/src/__tests__/`.

| Spec scenario (short quote) | Test file | Test title (exact) |
|---|---|---|
| "Every existing address form resolves as before" | 1. tower-messages.test.ts (describe `resolveTarget`, now goes through the new `parseTarget`)<br>2. tower-messages.test.ts<br>3. tower-messages.test.ts<br>4. tower-messages.test.ts<br>5. tower-messages.test.ts<br>6. spec-1313-registry-resolve.test.ts<br>7. spec-1313-registry-resolve.test.ts<br>8. agent-names.test.ts<br>9. address.test.ts [fixture rows `today: …`, lines 203-283]<br>10. tower-cron.test.ts | 1. `resolves "architect" to the architect terminal`<br>2. `resolves "arch" shorthand to the architect terminal`<br>3. `resolves exact builder ID (case-insensitive)`<br>4. `resolves bare numeric ID via tail match`<br>5. `resolves project:agent address`<br>6. `holds a bare builder that is registered but has no live PTY`<br>7. `holds a cross-workspace project:builder against the TARGET workspace registry`<br>8. `reads the forms the old parser read, into the structured address`<br>9. `$note — $input`<br>10. `keeps every local form, the new named-architect form included` |
| "bare `architect` from a builder" | 1. spec-755-phase3-routing.test.ts<br>2. spec-755-phase3-routing.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts (describe.each `affinity is for the sender's own workspace only, against %s`)<br>4. cross-workspace-addressing.e2e.test.ts | 1. `routes builder → "architect" → main in a single-architect workspace (fast path)`<br>2. `routes builder spawned by sibling → "architect" → sibling, NOT main`<br>3. `keeps today's affinity for bare architect and for <own workspace>:architect`<br>4. `the same builder reaches that workspace through its front door, and its own architect as before` |
| "…from a legacy builder" | 1. spec-755-phase3-routing.test.ts<br>2. spec-755-phase3-routing.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. spec-1940-cross-workspace-resolve.test.ts (describe.each `a builder whose architect has gone, in a workspace that has a main, against %s`; also checks `legacy-1`) | 1. `routes legacy builder (spawnedByArchitect=null) → "main" if present`<br>2. `errors verbatim when legacy builder has no main architect`<br>3. `refuses bare architect from a legacy builder, with the Spec 755 message`<br>4. `reaches main` |
| "…and from a non-builder" | 1. spec-755-phase3-routing.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts | 1. `routes non-builder send → "main" (no sender)`<br>2. `gives the front door, main, to an architect and to a human`<br>3. `still gives the first registered to a sender that is not a builder, and to one from another workspace` |
| "`codev-cloud:architect:tunnel` reaches `tunnel`" | 1. spec-1940-cross-workspace-resolve.test.ts (describe.each `a named architect in another workspace, against %s`)<br>2. same describe<br>3. tower-routes.test.ts<br>4. cross-workspace-addressing.e2e.test.ts<br>5. address.test.ts [row "G short 5: architect tunnel in codev-cloud, this Tower", fixture 36] | 1. `is reached by an architect`<br>2. `is reached by a sender that gives no id (a human at a shell)`<br>3. `delivers <workspace>:architect:<name> to that architect, as a same-workspace send would be`<br>4. `the headline path: a named architect in the other workspace gets the message under a qualified header`<br>5. `$note — $input` |
| "an unknown architect name fails naming the workspace" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. tower-routes.test.ts<br>4. cross-workspace-addressing.e2e.test.ts | 1. `fails for an unknown name, naming the workspace, its architects and its front door`<br>2. `says the unknown name the same way in the sender's own workspace, with the short front door`<br>3. `fails for an unknown architect name with a 404 that names the workspace, its architects and its front door`<br>4. `a named architect that does not exist fails naming the workspace, its architects and its front door` |
| "registered but with no live terminal is held `no-live-pty`" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. tower-routes.test.ts<br>3. cross-workspace-addressing.e2e.test.ts | 1. `is held, not refused, when the architect is registered and has no live terminal`<br>2. `holds it (no-live-pty) when the architect is registered and has no live terminal`<br>3. `a named architect that is registered but has no live terminal has its mail held no-live-pty` |
| "Malformed shapes fail with the expected shape" (in general) | 1. address.test.ts (describe `parseAddress: malformed addresses`; checks `expected` for every row)<br>2. address.test.ts<br>3. tower-routes.test.ts (describe `malformed addresses are a 400 that names the expected shape`)<br>4. spec-1940-cross-workspace-resolve.test.ts (describe `malformed shapes fail with the shape that was expected`) | 1. `$note — "$input" → $error`<br>2. `names the local shape for a local address and the afx:// shape for a remote one`<br>3. `%s (was a 404 "not found")`<br>4. `%s` |
| "two components after `architect`" | 1. address.test.ts [rows "two components after architect" fx 496, "two components after architect, no workspace" fx 501, "remote, two components after architect" fx 691]<br>2. spec-1940-cross-workspace-resolve.test.ts [row "two parts after architect"]<br>3. tower-routes.test.ts [row `codev:architect:a:b`] | 1. `$note — "$input" → $error`<br>2. `%s`<br>3. `%s (was a 404 "not found")` |
| "two before it (`devvm:codev:architect`)" | 1. address.test.ts [rows "two components before architect (a Tower written as a workspace)" fx 506, "two components before a named architect" fx 511, "remote, two components before architect" fx 686]<br>2. address.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. tower-routes.test.ts<br>5. tower-routes.test.ts (describe `a cron task's target`) | 1. `$note — "$input" → $error`<br>2. `words the Tower-written-as-a-workspace error the way the spec does`<br>3. `a Tower written as a second workspace`<br>4. `a Tower written as a second workspace`<br>5. `is not delivered, and says why, when it is not an address` |
| "with the hint to write `afx://devvm/codev:architect` when `devvm` is one of my Towers" | no test (left out on purpose) | The plan gives the shape error without the hint: a stage 1 Tower has no list of the owner's Towers. address.test.ts `words the Tower-written-as-a-workspace error the way the spec does` and tower-routes.test.ts `a Tower written as a second workspace` check the exact message, so they confirm the hint is absent. |
| "an `afx://` address with no workspace" | 1. address.test.ts [rows "remote with no path" fx 541, "remote with an empty path" fx 546, "remote with no workspace, front door" fx 551, "remote with no workspace, named architect" fx 556, "remote with no workspace, an id" fx 561]<br>2. spec-1940-cross-workspace-resolve.test.ts [rows "no workspace", "nothing after the Tower"]<br>3. tower-routes.test.ts [rows `afx://devvm`, `afx://devvm/architect`] | 1. `$note — "$input" → $error`<br>2. `a malformed one (%s) fails as malformed, not as unavailable`<br>3. `that is malformed (%s) fails as malformed, not as unavailable` |
| "an empty component" | 1. address.test.ts [rows "empty workspace" fx 471, "empty agent" 476, "empty architect name" 481, "empty component in the middle" 486, "whitespace-only component" 491, "remote with nothing after the scheme" 566, "remote with an empty tower" 571, "remote with an empty owner" 576, "remote with an owner and no tower" 581, "remote with an empty agent" 586]<br>2. spec-1940-cross-workspace-resolve.test.ts [rows "an empty part", "a leading colon"]<br>3. tower-routes.test.ts [rows `:architect`, `codev::architect`]<br>4. tower-messages.test.ts | 1. `$note — "$input" → $error`<br>2. `%s`<br>3. `%s (was a 404 "not found")`<br>4. `rejects empty agent after project: as MALFORMED_ADDRESS` |
| "a character outside the allowed set" | 1. address.test.ts [INVALID_COMPONENT rows: "tower with an underscore" fx 626, "tower with a dot" 631, "tower starting with a hyphen" 636, "owner with a dot" 641, "remote workspace with a space" 656, "remote workspace starting with a dot" 661, "remote architect name with a character outside the set" 666, "remote id with a character outside the set" 671, "remote workspace with an escape character" 711, "remote architect name outside ASCII" 716, "tower with a control character" 721]<br>2. address.test.ts (describe `parseAddress: what a refusal quotes back`) | 1. `$note — "$input" → $error`<br>2. ``%s with a character no terminal should be handed is quoted as `?` `` |
| "a port" | 1. address.test.ts [row "remote with a port", fx 596 → REMOTE_PORT]<br>2. spec-1940-cross-workspace-resolve.test.ts [row "a port"]<br>3. tower-routes.test.ts [row `afx://devvm:4100/codev:architect`] | 1. `$note — "$input" → $error`<br>2. `a malformed one (%s) fails as malformed, not as unavailable`<br>3. `that is malformed (%s) fails as malformed, not as unavailable` |
| "query" | address.test.ts [row "remote with a query", fx 601 → REMOTE_QUERY] | `$note — "$input" → $error` |
| "fragment" | address.test.ts [row "remote with a fragment", fx 606 → REMOTE_FRAGMENT] | `$note — "$input" → $error` |
| "percent-encoding" | address.test.ts [row "remote with percent-encoding", fx 611 → REMOTE_PERCENT_ENCODING] | `$note — "$input" → $error` |
| "a reserved word used as a workspace" | 1. address.test.ts [rows "reserved word as a remote workspace: arch" fx 676, "reserved word as a remote workspace: builder" fx 681 → RESERVED_WORKSPACE]<br>2. spec-1940-cross-workspace-resolve.test.ts [row "a reserved word as the workspace"]<br>3. address.test.ts | 1. `$note — "$input" → $error`<br>2. `a malformed one (%s) fails as malformed, not as unavailable`<br>3. `isReservedWorkspaceName covers the three words, in any case` |
| "Two workspaces share a basename: the address fails listing both" | 1. workspace-address.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts (describe `Spec 1940 phase 3 — explicit workspace names, in both resolvers` › `against %s`)<br>3. tower-routes.test.ts<br>4. cross-workspace-addressing.e2e.test.ts<br>5. tower-messages.test.ts | 1. `fails as ambiguous for two unnamed workspaces with one basename, naming both and the remedy`<br>2. `two workspaces that share a basename: the address fails, listing both paths and the command`<br>3. `two workspaces share a basename: the address fails listing both; after one is named, both resolve`<br>4. `the shared name fails as ambiguous, listing both, and nothing is stored`<br>5. `returns AMBIGUOUS when multiple workspaces share the same basename` |
| "after one is given an explicit name, both resolve" | 1. workspace-address.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. tower-routes.test.ts<br>4. cross-workspace-addressing.e2e.test.ts<br>5. spec-1940-address-book.test.ts | 1. `resolves both once one of them is named`<br>2. `after one is named, both resolve`<br>3. `two workspaces share a basename: the address fails listing both; after one is named, both resolve`<br>4. `after afx workspace name gives one of them a name, both resolve`<br>5. `once one is named, both have addresses again` |
| "explicit name refused when it is a reserved word" | 1. workspace-address.test.ts [rows architect, arch, builder, Architect, BUILDER]<br>2. tower-routes.test.ts [rows "a reserved word", "a reserved word in another case", "the alias arch"] | 1. `refuses the reserved word %s`<br>2. `refuses %s, with the reason, and stores nothing` |
| "…has a character outside the allowed set" | 1. workspace-address.test.ts [rows "has a space", "has a colon", "has a slash", "has an at sign", "starts with a hyphen", "starts with a dot", "is empty", "has a non-ASCII letter"]<br>2. tower-routes.test.ts [rows "a character outside the allowed set", "a colon", "an empty name"] | 1. `refuses a name that %s`<br>2. `refuses %s, with the reason, and stores nothing` |
| "…equals another workspace's address name (explicit…) in any letter case" | 1. workspace-address.test.ts<br>2. tower-routes.test.ts | 1. `refuses the explicit name of another workspace, in any letter case`<br>2. `refuses the explicit name of another workspace, in any letter case` |
| "…(…or basename) in any letter case" | 1. workspace-address.test.ts<br>2. workspace-address.test.ts<br>3. workspace-address.test.ts<br>4. tower-routes.test.ts [rows "the basename of another workspace", "that basename in another letter case"] | 1. `refuses the basename of another unnamed workspace, in any letter case`<br>2. `refuses a basename whose letter case differs on disk`<br>3. `refuses the basename of a running workspace that has no row`<br>4. `refuses %s, with the reason, and stores nothing` |
| "A workspace registered later whose basename equals an existing explicit name does not take the name" | 1. workspace-address.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. tower-routes.test.ts | 1. `an explicit name wins over a workspace that merely has that basename`<br>2. `a workspace whose basename equals an existing explicit name does not take the name`<br>3. `a workspace registered later whose basename equals an existing explicit name does not take the name` |
| "…it is reported as needing one of its own" | 1. workspace-address.test.ts<br>2. workspace-address.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. tower-routes.test.ts (checks 'a name of its own')<br>5. spec-1134-whoami.test.ts<br>6. spec-1940-address-book.test.ts | 1. `is none for a workspace whose basename is another workspace's explicit name, and says it needs its own`<br>2. `an explicit name whose workspace is not running fails saying so, and is never handed to a basename match`<br>3. `an explicit name whose workspace is not running fails saying so, and is never delivered to a basename match`<br>4. `a workspace registered later whose basename equals an existing explicit name does not take the name`<br>5. `has none when its directory name is another workspace's explicit name`<br>6. `a workspace whose directory name is another's explicit name says it needs one of its own` |
| "`afx whoami` prints the caller's own address… for an architect" | 1. spec-1134-whoami.test.ts (describe `the caller's own address (Spec 1940)`) [row "the main architect"]<br>2. spec-1134-whoami.test.ts | 1. `gives %s as <workspace>:architect:<name>`<br>2. `formats the human-readable lines exactly as specified` |
| "…a named architect" | spec-1134-whoami.test.ts [row "a named architect"] | `gives %s as <workspace>:architect:<name>` |
| "…and a builder" | 1. spec-1134-whoami.test.ts<br>2. spec-1134-whoami.test.ts | 1. `gives a builder as <workspace>:<builder id>`<br>2. `adds the address as the last line and changes no line before it` |
| "…in the form another workspace on this Tower would type" | 1. spec-1134-whoami.test.ts<br>2. spec-1134-whoami.test.ts | 1. `is the address the naming rules resolve back to this workspace`<br>2. `uses the workspace's explicit address name, not the display name or the directory name` |
| "`afx workspace name --clear` removes the explicit name" | 1. workspace-name.test.ts<br>2. tower-client-workspace-name.test.ts (SDK)<br>3. tower-routes.test.ts | 1. `--clear sends null and says the workspace is addressed by its directory name again`<br>2. `sends null to clear, as an explicit null and not a missing field`<br>3. `--clear: the workspace resolves by its basename again, and the name is free` |
| "…resolves by its basename again" | 1. tower-routes.test.ts<br>2. workspace-address.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts | 1. `--clear: the workspace resolves by its basename again, and the name is free`<br>2. `clearing a name takes effect at once: the old name stops resolving and the basename returns`<br>3. `clearing a name brings the basename back, and with it the ambiguity` |
| "…the old explicit name stops resolving at once" | 1. tower-routes.test.ts<br>2. workspace-address.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. tower-routes.test.ts (rename, not clear) | 1. `--clear: the workspace resolves by its basename again, and the name is free`<br>2. `clearing a name takes effect at once: the old name stops resolving and the basename returns`<br>3. `clearing a name brings the basename back, and with it the ambiguity`<br>4. `lets a workspace set the name it already has, and change it; the old name stops resolving at once` |
| "…the name is free for another workspace" | 1. tower-routes.test.ts (after clearing, `setName(WORK, 'cloud')` returns 200)<br>2. tower-routes.test.ts (a renamed workspace's old name is free)<br>3. workspace-address.test.ts (row removal, not `--clear`) | 1. `--clear: the workspace resolves by its basename again, and the name is free`<br>2. `lets a workspace set the name it already has, and change it; the old name stops resolving at once`<br>3. `removing a workspace's row frees its name for another workspace` |
| "`arch:review` reaches the agent `review` in a workspace whose basename is `arch`" | 1. spec-1940-cross-workspace-resolve.test.ts (describe `reserved words do not change what resolves today`)<br>2. address.test.ts [row "arch before a colon is a workspace, never the architect alias", fx 294] | 1. ``arch:review reaches the agent `review` in a workspace whose basename is `arch` ``<br>2. `$note — $input` |
| "`builder:architect` reaches the front door of a workspace whose basename is `builder`" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. address.test.ts [row "a workspace called builder keeps its front door", fx 303] | 1. ``builder:architect reaches the front door of a workspace whose basename is `builder` ``<br>2. `$note — $input` |
| "Neither workspace can be named in an `afx://` address until it has an explicit name" | 1. address.test.ts [rows "reserved word as a remote workspace: arch" fx 676, "…: builder" fx 681]<br>2. spec-1940-cross-workspace-resolve.test.ts [row "a reserved word as the workspace"] | 1. `$note — "$input" → $error`<br>2. `a malformed one (%s) fails as malformed, not as unavailable` |
| ↳ the "until it has an explicit name" half | no test | Stage 1 refuses every `afx://` address, so no test parses or sends one that uses the workspace's new explicit name. Closest: workspace-address.test.ts `refuses the reserved word %s` (an explicit name cannot be a reserved word) and `accepts every name validateProposedName accepts: an explicit name is always printable`. |
| "explicit name equal to the basename of a workspace that is registered but not running is refused" | 1. workspace-address.test.ts<br>2. tower-routes.test.ts | 1. `refuses the basename of a workspace that is registered but not running`<br>2. `refuses the basename of a workspace that is registered but not running` |
| "basename contains a space is still reached by its local address" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. tower-routes.test.ts<br>3. workspace-address.test.ts<br>4. address.test.ts [rows "local workspace with a space" fx 380, "local workspace with a space, named architect" fx 388] | 1. `a workspace whose basename has a space is still reached by its local address`<br>2. `a workspace whose basename has a space is still reached by its local address`<br>3. `matches a basename whatever its letter case or characters, as before`<br>4. `$note — $input` |
| "…refused in an `afx://` address until it has an explicit name" | 1. address.test.ts [row "remote workspace with a space", fx 656 → INVALID_COMPONENT]<br>2. workspace-address.test.ts [row "a space"]<br>3. spec-1134-whoami.test.ts<br>4. spec-1940-address-book.test.ts<br>5. workspace-address.test.ts (the "explicit name" half, indirectly) | 1. `$note — "$input" → $error`<br>2. `is none for a directory name with %s, and names the remedy`<br>3. `has none when the directory name cannot be written in an address`<br>4. `a directory name that cannot be written in an address is not printed as one`<br>5. `accepts every name validateProposedName accepts: an explicit name is always printable` |
| "builder addressing `<own workspace>:architect:<other>` is refused under the Spec 755 rule" | 1. spec-1940-cross-workspace-resolve.test.ts (describe.each `the builder rule, against %s`)<br>2. tower-routes.test.ts (describe `the builder rule`)<br>3. spec-755-phase3-routing.test.ts<br>4. spec-1940-cross-workspace-resolve.test.ts (own workspace written by its explicit name) | 1. `refuses <own workspace>:architect:<other> with the Spec 755 message, unchanged`<br>2. `refuses <own workspace>:architect:<other> exactly as Spec 755 does: 404 and its message`<br>3. `rejects architect:<other> from a builder spawned by a different architect (verbatim)`<br>4. `a sender writing its own workspace by its explicit name is in its own workspace` |
| "builder addressing a named architect in another workspace is refused" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. spec-1940-cross-workspace-resolve.test.ts<br>5. spec-1940-cross-workspace-resolve.test.ts<br>6. tower-routes.test.ts<br>7. tower-routes.test.ts<br>8. cross-workspace-addressing.e2e.test.ts | 1. `refuses a named architect in another workspace, naming that workspace's front door`<br>2. `refuses it even when that architect has the same name as the one that spawned the builder`<br>3. `refuses before it looks the name up, so a builder cannot learn which architects exist`<br>4. `refuses a legacy builder, which has no spawning architect to name, in both places`<br>5. `is still held to the builder rule when its id is a builder's: leaving the workspace out opens nothing`<br>6. `refuses a builder naming an architect in another workspace: 403, the front door named, nothing stored`<br>7. `refuses the same when the architect has no live terminal: it is refused, not held`<br>8. `a builder naming a named architect in another workspace is refused, told the front door, and nothing is stored` |
| "…whether or not that architect has messaged it" | 1. tower-routes.test.ts (has messaged: `architect:review` writes to the builder, then the builder's send to `codev:architect:review` gets 403)<br>2. cross-workspace-addressing.e2e.test.ts (has messaged: the setup probes sent review→builder first)<br>3. spec-1940-cross-workspace-resolve.test.ts (no earlier message)<br>4. tower-routes.test.ts (no earlier message)<br>5. spec-1940-reply-footer.test.ts | 1. `a builder is not given a command for a named architect that is not its own, and the address is refused if it tries`<br>2. `a builder naming a named architect in another workspace is refused, told the front door, and nothing is stored`<br>3. `refuses a named architect in another workspace, naming that workspace's front door`<br>4. `refuses a builder naming an architect in another workspace: 403, the front door named, nothing stored`<br>5. `is not offered the architect's address, which the resolver would refuse` |
| "…and the error names the front door" | 1. spec-1940-cross-workspace-resolve.test.ts (exact message)<br>2. tower-routes.test.ts<br>3. cross-workspace-addressing.e2e.test.ts<br>4. spec-1940-cross-workspace-resolve.test.ts | 1. `refuses a named architect in another workspace, naming that workspace's front door`<br>2. `refuses a builder naming an architect in another workspace: 403, the front door named, nothing stored`<br>3. `a builder naming a named architect in another workspace is refused, told the front door, and nothing is stored`<br>4. `the builder rule names the front door by the name the sender wrote` |
| "The same builder reaches `<other workspace>:architect`" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. tower-routes.test.ts<br>3. cross-workspace-addressing.e2e.test.ts | 1. `reaches another workspace's front door, as today`<br>2. `sends <other workspace>:architect from the builder to main there, not to a namesake of its own architect`<br>3. `the same builder reaches that workspace through its front door, and its own architect as before` |
| "…and its own architect by name with or without its workspace" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. tower-routes.test.ts<br>3. tower-routes.test.ts | 1. `lets a builder name its own spawning architect, with or without its workspace in front`<br>2. `lets the builder reach its own architect by name, with or without its workspace in front`<br>3. `a builder reaches its own architect with its workspace's explicit name in front` |
| "`<workspace>:architect` sent by a builder in another workspace reaches `main`, not the builder's spawning architect" | 1. spec-1940-cross-workspace-resolve.test.ts (describe.each `affinity is for the sender's own workspace only, against %s`)<br>2. same describe<br>3. tower-routes.test.ts<br>4. cross-workspace-addressing.e2e.test.ts | 1. `sends <other workspace>:architect from a builder to that workspace's main, not to a namesake of its architect`<br>2. `asks nothing about the sender to do so`<br>3. `sends <other workspace>:architect from the builder to main there, not to a namesake of its own architect`<br>4. `the same builder reaches that workspace through its front door, and its own architect as before` |
| "cross-workspace message between architects shows the qualified sender and a reply command" | 1. message-format.test.ts (describe `formatCrossWorkspaceMessage (Spec 1940)`)<br>2. tower-routes.test.ts (describe `carries the sender's qualified address and a reply command on every path`; sibling tests at 2895, 2901, 2908, 2915, 2925)<br>3. cross-workspace-addressing.e2e.test.ts<br>4. spec-1940-reply-footer.test.ts | 1. `writes the spec's frame for an architect writing to an architect`<br>2. `delivered to a live terminal`<br>3. `the headline path: a named architect in the other workspace gets the message under a qualified header`<br>4. `names the sender by its workspace-qualified address, with the kind its id has` |
| "pasting the reply command delivers to the original sender" | 1. cross-workspace-addressing.e2e.test.ts<br>2. tower-routes.test.ts (describe `the reply command, pasted unchanged by the recipient, reaches the original sender`) [row "an architect answers a named architect"]<br>3. spec-1940-reply-footer.test.ts (describe.each `$row` [row "an architect, from a named architect"]) | 1. `the reply command on that frame, run unchanged by the recipient, reaches the original sender`<br>2. `$row`<br>3. `prints a command that is accepted when the recipient sends it, and reaches the original sender` |
| "The footer, for each row of the table in Decision 7: the command shown is accepted when the recipient runs it" | 1. spec-1940-reply-footer.test.ts (describe.each `$row`, TABLE at 140-145; rows "an architect, from a named architect", "an architect, from the main architect", "an architect, from a builder", "a builder, from a builder", "a builder, from the front door of another workspace"; renders as `offers codev:architect:review`, `offers codev:architect:main`, `offers codev:builder-spir-12` (twice), `offers codev:architect`)<br>2. same describe.each<br>3. spec-1940-reply-footer.test.ts<br>4. tower-routes.test.ts [rows "an architect answers a named architect", "an architect answers a builder", "a builder answers a builder", "a builder answers the front door"]<br>5. cross-workspace-addressing.e2e.test.ts | 1. ``offers ${reply}`` (template literal)<br>2. `prints a command that is accepted when the recipient sends it, and reaches the original sender`<br>3. `agrees with the resolver for every sender and recipient: an offered command is never refused`<br>4. `$row`<br>5. `a named architect writing to a builder elsewhere: the builder is told how to answer, and the answer arrives` |
| ↳ Decision 7 row "A named architect in a front-door-only workspace" | not built: phase 7 cut | none |
| "a builder messaged by a named architect that is not its own is told to reply through its architect" | 1. spec-1940-reply-footer.test.ts [row "a builder, from a named architect that is not its own"; renders `offers <through-architect>`]<br>2. spec-1940-reply-footer.test.ts (describe `a builder and a named architect that is not its own`)<br>3. same describe<br>4. same describe<br>5. message-format.test.ts<br>6. tower-routes.test.ts<br>7. cross-workspace-addressing.e2e.test.ts | 1. ``offers ${reply}``<br>2. `is not offered the architect's address, which the resolver would refuse`<br>3. `is not offered the front door, which would reach a different architect`<br>4. `is told the same when the sender has the name of the architect that spawned it`<br>5. `sends a builder that may not address the sender through its own architect, in the spec's words`<br>6. `a builder is not given a command for a named architect that is not its own, and the address is refused if it tries`<br>7. `a named architect writing to a builder elsewhere: the builder is told how to answer, and the answer arrives` |
| "A workspace set to front door only: …" (every claim in the bullet) | not built: phase 7 cut | Owner ruling main-31; `phase_7` is `skipped` in `status.yaml`. A search of `packages/` and `apps/` for the setting under any spelling finds nothing, in tests or source. |
| "registered but has no live terminal is held, on the immediate path" | 1. tower-routes.test.ts<br>2. spec-1940-cross-workspace-resolve.test.ts<br>3. cross-workspace-addressing.e2e.test.ts<br>4. tower-routes.test.ts<br>5. tower-routes.test.ts (cron path) | 1. `holds it (no-live-pty) when the architect is registered and has no live terminal`<br>2. `is held, not refused, when the architect is registered and has no live terminal`<br>3. `a named architect that is registered but has no live terminal has its mail held no-live-pty`<br>4. `held for a registered recipient with no terminal (the registry hold)`<br>5. `reaches a named architect in another workspace, and holds for one with no live terminal` |
| "…and on the delayed path" | 1. tower-routes.test.ts<br>2. tower-routes.test.ts (frame on the delayed path; recipient is live) | 1. `schedules it on the --delay path too, with no live terminal`<br>2. `scheduled with --delay` |
| "A cron task whose target is an `afx://` address… is refused when the task file is loaded" | 1. tower-cron.test.ts (describe `a target that is an afx:// address`)<br>2. tower-cron.test.ts<br>3. tower-routes.test.ts (backstop when the task fires) | 1. `is refused when the task file is loaded, naming the task`<br>2. `is refused with an owner in it and in any letter case`<br>3. `is not delivered for an afx:// address, should one get past the loader` |
| "`afx interrupt` with such an address is refused" | 1. spec-1273-interrupt.test.ts<br>2. tower-routes.test.ts<br>3. spec-1273-interrupt.test.ts<br>4. spec-1273-reset-command.test.ts (`afx refresh`, related) | 1. `refuses an afx:// address before calling Tower`<br>2. ``is refused on the delayed path, and for an interrupt (`afx interrupt`), by Tower itself``<br>3. `leaves a malformed afx:// address for Tower to refuse as malformed`<br>4. `refuses an afx:// address before looking the builder up or calling Tower` |
| "same parser result… by the CLI, Tower and the extension for a shared table" | 1. address-conformance.test.ts (codev; one file covers both CLI and Tower; describe `address conformance: the shared table`)<br>2. address-conformance.test.ts (codev)<br>3. address-conformance.test.ts (vscode)<br>4. address-conformance.test.ts (vscode)<br>5. address.test.ts (SDK, same fixture) | 1. `parse: $note — "$input"`<br>2. `format: $note → $text`<br>3. `parse: $note — "$input"`<br>4. `format: $note → $text`<br>5. `$note — $input` / `$note — "$input" → $error` |
| "A shell id resolves within the workspace…" | 1. spec-1940-cross-workspace-resolve.test.ts (describe `shell ids resolve as today`)<br>2. tower-messages.test.ts<br>3. address.test.ts [row "today: shell id", fx 237] | 1. `alone, in the sender's workspace`<br>2. `resolves exact shell ID`<br>3. `$note — $input` |
| "…and as `<workspace>:<shell-id>`, as today" | 1. spec-1940-cross-workspace-resolve.test.ts<br>2. tower-routes.test.ts<br>3. spec-1940-cross-workspace-resolve.test.ts<br>4. address.test.ts [row "today: shell id in another workspace", fx 245] | 1. `as <workspace>:<shell-id>`<br>2. `resolves a shell id as <workspace>:<shell-id>, as today`<br>3. `a shell in a named workspace is reached as <name>:<shell-id>`<br>4. `$note — $input` |
| "With Tower never connected to the cloud, all of the above pass" | cross-workspace-addressing.e2e.test.ts (describe `Spec 1940: cross-workspace addressing on a real Tower that has never connected to Codev Cloud`, line 276) | `this Tower has never connected to Codev Cloud` |
| "`afx://devvm/codev:architect` is refused with the stated reason" | 1. cross-workspace-addressing.e2e.test.ts<br>2. tower-routes.test.ts (describe `an afx:// address`) [row "never connected to Codev Cloud"]<br>3. spec-1940-cross-workspace-resolve.test.ts [row `afx://devvm/codev:architect`]<br>4. agent-names.test.ts | 1. `an afx:// address is refused with the stated reason, and nothing is stored`<br>2. `is refused as cross-Tower messaging not available on a Tower %s`<br>3. `%s is refused as cross-Tower messaging not available`<br>4. `has one refusal text, which says cross-Tower messaging is not available` |
| "…refused the same way on a connected Tower" | tower-routes.test.ts [row "connected to Codev Cloud"] (route level only; there is no e2e on a connected Tower) | `is refused as cross-Tower messaging not available on a Tower %s` |
| "A same-workspace message has a byte-identical header to today's" | 1. tower-routes.test.ts (describe `frames that Spec 1940 does not change`: expected frames recorded on the commit before phase 4)<br>2. same describe<br>3. same describe<br>4. spec-1940-reply-footer.test.ts (describe `messages that keep today's frame`) | 1. `same workspace, %s to an architect (%s)`<br>2. `same workspace, %s to a builder and to a shell`<br>3. `same workspace with the workspace written in front of the address`<br>4. `a sender in the recipient's own workspace` |
| "Every new frame has exactly three lines" | 1. message-format.test.ts<br>2. message-format.test.ts (older #1574 guard) | 1. `is three lines for every footer, and a 40-byte body is typed by the short write path`<br>2. `does not grow the frame beyond 3 lines, so the write path is unchanged` |
| "a cross-workspace message with a 40-byte body is typed by the short write path" | 1. message-format.test.ts<br>2. tower-routes.test.ts<br>3. message-format.test.ts | 1. `is three lines for every footer, and a 40-byte body is typed by the short write path`<br>2. `types a cross-workspace frame with a 40-byte body as one short write, not as a paste`<br>3. `leaves the spec's example frame 87 bytes of body on the short path` |

## Deviations from Plan

**Phase 1 (shared address contract and parser).** The plan held. Two malformed forms the old
parser passed on to "not found" (`:agent`, `a:b:c`) are parse errors. Added in review: owner
handles start with a letter; a mistyped scheme (`afx:/…`, `afx//…`) fails naming `afx://`; an
address longer than 512 characters fails as `ADDRESS_TOO_LONG`; a refused value is quoted as
printable ASCII, cut at 64 characters; `AgentAddress` is a discriminated union.

**Phase 2 (named architects across workspaces, the builder rule).**

- The plan says both "403 for refused" and "every resolution test passes without its
  expectations changed". The Spec 755 refusal (a builder naming another architect in its *own*
  workspace) keeps `NOT_FOUND` / 404 and its message, because existing tests pin both. Only the
  new case, a named architect in *another* workspace, is `REFUSED` / 403.
- Two existing expectations changed beyond the two the plan names: `project:` and a blank target
  now give `MALFORMED_ADDRESS` where they gave `NO_CONTEXT` (400 either way).
- `spec-1307-send-delay.test.ts` is listed in the plan and unchanged: it calls no resolver. The
  delayed path is covered in `tower-routes.test.ts`.
- **Two older bugs fixed in place**, both found by review. (1) For bare `architect` from a
  builder with no architect of its own in a workspace with no `main`, the registry resolver
  answered "the first registered" where the live resolver refuses, and the send route consults
  the registry on any not-found, so that mail was held for, and then delivered to, an unrelated
  architect. The registry now refuses where the live resolver does. (2) Issue #1633:
  `getArchitects` sorted by name, so with no `main` an offline hold named the alphabetically
  first architect where a live send reached the first registered. It now orders `main` first,
  then by start time. A side effect: at workspace start, sibling architects relaunch `main`
  first and then in registration order (it was name order).
- `origin/main` was merged in (`6df1df753`) so GitHub would run checks on the draft PR. One
  conflict, in `packages/sdk/src/tower-client.ts`; both sides' fields are kept.

**Phase 3 (explicit workspace names).**

- **The plan and the spec disagree on one sentence, and the spec was followed.** For a workspace
  registered later whose directory name equals an existing explicit name, the plan says "its
  bare basename fails with a message that says it needs a name of its own"; the spec says "the
  explicit name keeps resolving to the workspace that holds it". Both cannot hold for the same
  text. As built: the name resolves to its holder while the holder runs. When the holder is not
  running the address fails, says so, and names the running workspace with that directory name
  as needing a name of its own. The listing and whoami report that workspace as having no
  address name, with the reason.
- A 64-character limit on names was added by the builder, was not in the spec, and was removed
  in review. The address-fit rule (see Known boundaries) replaced it on the architect's decision.
- Error wording for an unknown or ambiguous workspace reads "Workspace 'x' …" (it was "Project
  'x' …"); the codes are unchanged.
- The first commit of the phase is not in the plan: it fixes a defect of the builder's own. The
  opt-in latency test from phase 1 stopped its Tower without deactivating the workspace, and
  left 18 shellper processes behind over ten runs. The teardown now deactivates and asserts that
  no process naming the test's socket directory survives. The architect ended the 18 on the
  owner's word, each checked against Tower's terminal list first.

**Phase 4 (qualified provenance and reply commands).**

- The plan put the reply logic in `tower-routes.ts`. It is in `tower-messages.ts`
  (`crossWorkspaceOrigin`), beside the resolvers it calls. The architect agreed.
- **The front door rule is a deliberate reading of the spec's row "the `main` architect".** A
  builder written to by a named architect elsewhere is offered that workspace's front door only
  when the real resolver says the front door reaches that sender now. In a workspace with a
  `main` this is the spec's row. The case it adds: with no `main`, the first registered
  architect gets the front door as its reply. When the front door would reach someone else, the
  builder sees `reply through your architect`. The architect agreed.
- A sender in a workspace with no usable name is shown as `architect:review (another workspace)`
  with the footer `no reply address; the sender's workspace needs: afx workspace name <name>`.

**Phase 5 (workspace list and whoami).**

- The plan says `sendable` "comes from the phase 2 permission check, asked as the caller". It is
  found by writing the address as text, reading it back with the shared parser and resolving it
  as the caller, as the send route does. The permission check alone was wrong in two tested
  cases (a shell whose id is the tail of a builder's id; two builder ids that differ only in
  letter case).
- `live` is the send route's own test (the session exists and is writable), not presence in the
  terminal map. A workspace that is not running is listed with no agents. A directory name that
  cannot be written in an address is listed as having no address name.
- First commit (`47aedc3ef`): the front door is resolved only when the sender's own address is
  refused, from the phase 4 review.
- One push was red on GitHub (`f3ed3d453`): a made-up path in a new test began with `/tmp`,
  which the residue check refuses. Fixed in the test; the allowlist is untouched.

**Phase 6 (docs and end-to-end checks).**

- **Not in the plan: a CLI newer than the running Tower.** The architect ran this build's CLI
  against the installed Tower and found `afx workspace list` printing a bare `Not found` and
  `afx whoami` giving wrong advice. Fixed for four commands (`workspace list`, `workspace name`,
  `whoami`, and `afx send` of the three-part form), each tested against the older shape.
  `afx workspace name` was not on the architect's list; it had the same defect.
- The plan says the end-to-end test replaces one thing, the port. It replaces two: the port and
  the file the CLI opens as global.db. A builder sender's identity is verified against
  global.db, so it has to be the test Tower's.
- The plan's criterion "the diff of each template pair is empty" was inexact: each
  `CLAUDE.md`/`AGENTS.md` template pair already differed in its title and one note, and still
  differs in exactly those. The `codev/` and `codev-skeleton/` copies of each are identical.
- The skeleton's `resources/commands/agent-farm.md` had drifted from the `codev/` copy before
  this project. Its `afx send`, workspace and whoami sections were brought up to date; the rest
  was not ported.
- The first Windows run on this branch was red on 30 tests, all in this project's block of
  `tower-routes.test.ts`: the fixture seeded workspaces under the short temp spelling Windows
  hands out, and the routes key by the canonical one. One line in the fixture; no route changed.
- **Found, not changed: a workspace's architect command is split on whitespace**
  (`architectCmd.split(/\s+/)` in `tower-instances.ts`, for the main architect and for an added
  one; an array value is joined and split the same way). This is Tower's production launch path,
  so on a real Tower any architect command with a quoted argument containing a space is broken;
  a command of plain words and flags is not affected. Issue #1966.

**Phase 7 (front-door-only setting).** Cut by the owner at plan approval; recorded with
`porch skip-phase`.

**Porch's local tests check.** The plan assumed porch's checks run as written. The local full
suite fails under its own load on this machine (issue #1956), so on the owner's rulings a green
GitHub run on the same head stood in for it:

| Phase | Local tests check | GitHub run that stood in |
|---|---|---|
| 1 | Failed once, passed on the second run | none needed |
| 2 | Failed (92 timeouts in 17 unrelated files, load 33 to 49); skipped under ruling main-32 | 8 of 8 green at `6804f57c7`, then `66ea5c747` |
| 3 | Failed once (5 unrelated files); skipped under main-32 | 8 of 8 green at `0a553e80b`, `18a9c86a8`, `4c9d9c967` |
| 4 | Not run (ruling main-38, "ci-first") | 8 of 8 green at `ba33ee37b` |
| 5 | Not run (main-38) | 8 of 8 green at `6462b2563` |
| 6 | Not run (main-38) | 8 of 8 green at `ef6d5162c`; Windows run 45314039137 green on its second attempt |

Each skip was made in the worktree's untracked `.codev/config.local.json`, for one `porch done`,
after the architect had checked the run; the file was restored in the same command. Porch's build
check ran every time.

## Consultation Feedback

Porch ran two reviewers for this project, Codex and Claude; there was no Gemini lane. No
`CONSULT_ERROR` occurred. Three outputs carry the "working tree changed" warning (#1649): Claude's
in the first spec round, where the builder edited the spec while that lane was still running, and
both in the plan round, where the builder appended to the thread log and the plan itself was not
touched. No reviewer wrote to the tree.

### Specify Phase (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: Scope undecided between stage 1 and the whole design. → **Addressed**: the stage 1
  criteria are named as this project's under the recommended answer to Open Question 4.
- **Concern**: "Builder replies" had no authorization contract. → **Addressed**, then replaced in
  the third revision by the plain builder rule.
- **Concern**: Grant withdrawal semantics conflict. → **Addressed**: three stated effects.
- **Concern**: Exactly-once underspecified. → **Addressed**: a lifecycle by id and send time.
- **Concern**: The human-release boundary is not enforceable. → **Addressed**: described as a
  safeguard against the remote sender, not a barrier against a local process.
- **Concern**: Remote-body framing too vague. → **Addressed**: a testable invariant.
- **Concern**: Workspace naming rules incomplete. → **Addressed**.
- **Concern**: Limits deferred to the plan. → **Addressed**: a limits table with defaults.

#### Claude (REQUEST_CHANGES)
- **Concern**: The grammar dropped shell ids. → **Addressed**: widened to a local id.
- **Concern**: Sender-held outbound mail collides with the Spec 1313 drainer and escalation. →
  **Addressed**: a distinct kind of held mail, with criteria.
- **Concern**: The sending leg is not the tunnel. → **Addressed**.
- **Concern**: Four header cases, not three. → **Addressed**.
- **Concern**: Minor items (frame growth and the write path, ordering, wording). → **Addressed**.

### Specify Phase (Round 2, run by hand at the gate on the architect's instruction)

#### Codex (REQUEST_CHANGES)
- **Concern**: Scope and core contracts left as open questions. → **Addressed** in part: they
  are the owner's to decide at the gate, so they stayed open questions; the spec now says it is
  written under each recommended answer and that approval adopts them.
- **Concern**: "Exactly once" overstated. → **Addressed**: it is one mailbox row.
- **Concern**: Sender-held retention contradictory. → **Addressed**: a fixed 30-day lifetime.
- **Concern**: Workspace-name collision rules conflict. → **Addressed**: both orders of events.
- **Concern**: Mixed-version behaviour missing. → **Addressed**.

#### Claude (REQUEST_CHANGES)
- **Concern**: The stage order inverts the owner's. → **Rebutted**: it read the stale spawn
  prompt; the owner had reordered the issue.
- **Concern**: The 48 KB cap is only the `--file` cap. → **Rebutted**: it is
  `MAX_MESSAGE_BYTES`, enforced on the message in the CLI and in Tower's `/api/send`.
- **Concern**: The frame must stay three lines or the write path flips. → **Addressed**: the
  reply goes on the footer line, with measured byte budgets.
- **Concern**: The remote header presents the peer's claims as authenticated. → **Addressed**:
  only owner and Tower are cloud-authenticated; workspace and agent are the sender's claim.
- **Concern**: Minor consistency items. → **Addressed**.

### Specify Phase (Round 3, after the owner's third revision)

#### Codex (REQUEST_CHANGES)
- **Concern**: The attestation has no unique id; replay consumption ambiguous; the sanitised
  character set undefined. → **Addressed**: a statement id consumed before authorization; an
  exact code-point list.

#### Claude (COMMENT)
- **Concern**: Stage 1 refuses every `afx://` yet self-naming was declared legal; held-for-release
  has no lifetime; the walkthrough teaches `--all`; missing footer row; plan-level material in
  the spec. → **Addressed**, all of them.

### Specify Phase (Round 4, the final pass)

By the architect's instruction nothing was changed straight after this pass. Later the same day,
also on instruction, all fifteen points were applied in one commit (`90ebb0245`) with no further
review. **The spec text the owner approved is one commit ahead of what the reviewers read.** The
points and their fixes are listed in
`codev/projects/1940-tower-to-tower-messaging-proto/1940-specify-iter4-open.md`.

#### Codex (REQUEST_CHANGES)
- **Concern**: `arch:review` today means agent `review` in a workspace `arch`; message-id reuse
  with a different envelope; switching remote messaging off and already-accepted mail; cloud
  limits versus local configuration. → **Addressed** in `90ebb0245`.

#### Claude (COMMENT)
- **Concern**: Eleven points (owner handles are a stage 3 dependency; no cap on sender-held mail;
  the relay-capability probe; a transient attestation failure treated as final; name uniqueness
  against registered workspaces; grants and identities; reserved words versus compatibility; the
  ordering promise; a latency threshold; criteria for `whoami` and `--clear`; the front-door
  setting and existing grants). → **Addressed** in `90ebb0245`.

### Plan Phase (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: Phase 7 cannot be optional; move the docs phase after it. → **Rebutted in part**:
  the plan was changed to say it builds phase 7 and reruns phase 6's checks in it; it stayed last
  and separable on the architect's instruction, pending the owner's ruling. The owner then cut it.
- **Concern**: `loadConfig` merges layers the spec excludes. → **Addressed** (in phase 7's text).
- **Concern**: `parse(format(a)) = a` cannot hold for reader-relative forms. → **Addressed**: the
  invariant is stated with the reader in it.
- **Concern**: The end-to-end test must run the built `afx send`. → **Rebutted in part**: the
  binary always connects to port 4100, the live Tower. The test drives the CLI's own `send`
  function against a test Tower; the installed binary is the verify phase's check.
- **Concern**: One of the six frame call sites is a pseudo-sender. → **Addressed**.
- **Concern**: The latency baseline procedure is underspecified. → **Addressed**: taken first.

#### Claude (COMMENT)
- **Concern**: A missing resolver call site in `mailbox-wiring.ts`; the version pin in
  `send-architect-identity.test.ts`; `senderWorkspace` can be the literal `unknown`; the affinity
  sentence was ambiguous; the listing was false for a builder caller; "expectations untouched"
  too broad; phase 7's uncached config read; "the e2e suite" would run the porch benchmark; two
  naming fixes. → **Addressed**, all nine.

### Phase 1 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: Owner handles may start with a digit. → **Addressed**: a separate owner pattern.

#### Claude (APPROVE)
- **Concern**: A mistyped scheme parses as a local address. → **Addressed**.
- **Concern**: `isAddressComponent` rejects upper case; `formatAddress` throws by design. →
  **Addressed** in phases 3 and 4, where they bite (lower-case before validating; check before
  formatting).

### Phase 1 (Round 2)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: `completeAddress` deletes an owner with no Tower; `AgentAddress` should be a
  discriminated union; parse errors quote the raw refused value; no length bound on an address. →
  **Addressed**, all four, as the first work of phase 2.

### Phase 2 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: The registry fallback can misroute a builder's mail to an unrelated architect. →
  **Addressed** (`d106d3984`).

#### Claude (APPROVE)
- **Concern**: The same divergence, as a comment. → **Addressed**.
- **Concern**: The terminal lookup precedes the builder-rule refusal. → **N/A**: unreachable in
  practice; not changed.
- **Concern**: `arch.md` still describes the old parser. → **Addressed** in phase 6.

### Phase 2 (Round 2)

#### Codex (REQUEST_CHANGES)
- **Concern**: With no `main`, the registry picks the alphabetically first architect (issue
  #1633). → **Addressed** (`66ea5c747`).

#### Claude (APPROVE)
- **Concern**: A builder that omits its workspace and names its own workspace is refused. →
  **N/A**: deliberate, fails closed; recorded under Known boundaries.
- **Concern**: Error strings interpolate an unchecked workspace name. → **N/A**: recorded under
  Known boundaries.

### Phase 2 (Round 3)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: "The sender's own workspace" is decided by comparing path text. → **Addressed** in
  phase 3: one helper, keyed by `workspaceKey`.
- **Concern**: The live front door follows insertion order. → **N/A**: recorded under Known
  boundaries; not changed.

### Phase 3 (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: A 64-character limit on names is not in the spec. → **Addressed**: removed.

#### Claude (APPROVE)
- **Concern**: The name route ignored the write's result; a unique-index refusal would be an
  uncaught throw; errors named a workspace by its directory, not by what the sender wrote. →
  **Addressed**, all three.

### Phase 3 (Round 2)

#### Codex (REQUEST_CHANGES)
- **Concern**: The naming route refuses Windows UNC paths. → **Rebutted** (the architect's
  decision): the check is the line every existing workspace route uses, so it is not this
  phase's; issue #1960.

#### Claude (APPROVE)
- **Concern**: Workspaces told apart by path text; a lookup trusted its caller to lower-case. →
  **Addressed**.
- **Concern**: No `PUT` in the CORS methods; `quoted()` duplicated. → **N/A**: left on purpose.

### Phase 3 (Round 3)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: The `NAME_TAKEN` wording for a shared directory name; which name wins when two
  rows spell one directory. → **Addressed** in phase 5 (a new sentence; a comment and two tests),
  so that a reviewer saw the change.

### Phase 4 (Round 1)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: The front door is resolved even when the answer is thrown away. → **Addressed**
  as the first commit of phase 5.
- **Concern**: A stored reply command can go stale; the asymmetry when the sender's workspace is
  stopped; unchecked names in error strings. → **N/A**: recorded under Known boundaries.

### Phase 5 (Round 1)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: The text listing does not keep every field to one printable line; whoami gives
  one reason for every failure to read the names. → **Addressed** in the first commit of phase 6.
- **Concern**: One query per listed agent; two stopped workspaces sharing a name. → **N/A**:
  recorded under Known boundaries.

### Phase 6 (Round 1)

#### Codex (APPROVE)
- No concerns raised.

#### Claude (APPROVE)
- **Concern**: The unknown-architect hint lists live architects only; the older-Tower check
  builds a whole address book; one whoami message has no remedy. → **N/A**: none blocking, none
  changed; recorded under Known boundaries and Follow-up Items.

### Review Phase (Round 1)

#### Codex (REQUEST_CHANGES; "no blocking implementation defect found")
- **Concern**: PR #1957 is still marked draft. → **Addressed**: it was a draft because it was
  opened early so that GitHub would run the suite; marked ready for review.
- **Concern**: The spec and the plan lack `approved` / `validated` frontmatter. → **Rebutted**:
  that frontmatter is for a spec or plan approved and committed to `main` *before* a builder is
  spawned, so that porch treats the phase as done. These two were written by the builder and
  approved by the human at porch's own gates, which `status.yaml` records (`spec-approval`,
  `plan-approval`). Adding `validated: [codex, claude]` to the spec would also overstate it: the
  approved text is one commit ahead of what the reviewers read.
- **Concern**: Commit `d4cb7e648` carries a `Co-Authored-By` trailer. → **N/A**: true, and
  disclosed. Removing it means rewriting the history of an open pull request and force-pushing,
  which the builder may not do without the owner's word. Put to the owner at the `pr` gate.

#### Claude (APPROVE)
- **Concern**: The `afx` skill says a builder is refused `<workspace>:architect:<name>`, but a
  builder that writes its own workspace's name in front of its own spawning architect is
  accepted. → **Addressed**: one clause added to the skill (four copies, hashes regenerated)
  and to `agent-farm.md` in both trees.
- **Concern**: The latency baseline and the after figure were taken at different loads. →
  **Addressed** in this document: the Latency section now says the comparison is one-sided and
  what supports the conclusion; a retake is a follow-up item.
- **Concern**: Confirm issue #1605 is really superseded, since the front-door-only setting was
  cut. → **N/A**: the owner's ruling at plan approval (main-31) cut the setting and said the
  issue still closes as superseded. Passed to the architect, who closes it.
- **Concern**: `afx workspace list` costs one resolve per agent with no cache. → **N/A**:
  deliberate; recorded under Known boundaries.
- **Concern**: `status.yaml` records review rounds only when one asked for changes, so phases 4
  to 6 look unreviewed there. → **N/A** for this PR (porch's bookkeeping); added under
  Methodology Improvements.
- **Concern**: Whether the branch is current with `main` could not be checked. → **N/A**:
  GitHub reports the PR mergeable, and its runs test the merge with `main`.

## Lessons Learned

### What Went Well

- **One parser, one table.** The address is text only at the edges. The same table of cases runs
  in the SDK, in `packages/codev` and in the VS Code extension, so the three cannot disagree.
- **Printed addresses are checked by using them.** Every reply command and every listed address
  is resolved, in the tests, by the real resolvers as the reader. That is what found the two
  cases where a copy of the permission rules would have been wrong.
- **The record of "before" was committed before the change**: the latency baseline, and the
  frames that must not change.
- **Review found real defects.** Codex found a misroute older than the project and issue #1633;
  Claude's non-blocking notes were carried forward and fixed where a later review would see them.
- **A check on a real Tower in each phase** found things no unit test did (an agent called
  `live` whose mail was then held; architects on a test Tower that had exited at once).

### Challenges Encountered

- **The local full suite fails under its own load** (issue #1956). Resolved by the owner's
  rulings: a green GitHub run on the same head stands in, and the architect checks it first.
- **The builder leaked 18 shellper processes** from its own opt-in test. Resolved by making the
  teardown assert that nothing survives.
- **The first Windows run came in phase 6** and was red on 30 tests written in phases 2 to 5.
  The cause was one fixture line, but it was found four phases late.
- **A new CLI against the Tower already running** printed a bare `Not found`. Found by the
  architect, not by the builder or either reviewer.
- **The plan and the spec disagreed on one sentence** in phase 3. Resolved by following the spec
  and saying so.
- **Working-tree discipline.** The builder wrote to the tree while review lanes were running,
  twice (the spec round and the plan round), and started a command with a bare `cd` seven times
  (the seventh in the review phase). Nothing was written from a wrong directory.

### What Would Be Done Differently

- Dispatch the Windows workflow at the first phase that seeds workspaces in tests.
- Run the new CLI against the installed Tower at the end of every phase that adds a route or a
  column. It is the state every user is in right after upgrading.
- Run the first step of the CI job (`node scripts/tmp-residue-check.mjs`) before every push.
- Keep the scenario-to-test table from phase 1 and grow it per phase, not build it at the end.
- The first commit of the spec carries a `Co-Authored-By` trailer, against the owner's rule. It
  was pushed before it was noticed and was left in place so as not to force-push; no later
  commit has one.

### Methodology Improvements

- **Porch prints only the first lines of a failed check and keeps no copy**, so a failing test
  could not be named. It should keep the full output of a failed check.
- **Porch force-advances a phase at its third review iteration**, so a fix made after round 3 is
  seen by no reviewer. The prompt for round 3 should say so.
- **A phase's checks should include the new CLI against an older Tower** whenever the phase adds
  a route, as a line in the plan template.
- **`porch.checks.tests` has no way to say "GitHub's run on this head is the check"**; the
  one-time skip by hand, under a standing ruling, was the working substitute.
- **`status.yaml` records a review round only when a reviewer asked for changes.** Phases 4, 5
  and 6 each had one round in which both reviewers approved, and the committed status file shows
  no review for them at all. Porch should record every round with its verdicts.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md`, Inter-Agent Messaging (in phase 6). The stale
  description of the two-slot `parseAddress` intercept is corrected, and the section gains: one
  structured address and one parser, with the table of address forms; the builder rule
  (permission and affinity as separate questions); workspace address names; cross-workspace
  frames; the address book; a CLI newer than the running Tower.
- No change to the hot file `arch-critical.md`. It is at its cap of ten facts, none of them is
  made untrue by this project, and the new material is subsystem detail that a builder needs
  only when touching addressing. The existing mailbox-first fact still holds: the new frames
  are composed before the mailbox write and nothing writes a terminal directly.

## Lessons Learned Updates

- Routed: cold — Architecture — tell a user "this address works" only from the real resolver's
  answer, asked as that caller.
- Routed: cold — Architecture — two resolvers for one question drift; share the lookup and the
  permission check and test every refusal against both.
- Routed: cold — Process — GitHub runs no checks on a pull request that conflicts with its base;
  run the job's first step locally before pushing.
- Routed: cold — Testing — make the leak check an assertion in the teardown (extends the #1911
  lesson, which was already written when this project leaked).
- Routed: cold — Testing — a fixture that seeds a workspace spells its path with
  `workspaceKey()`; run Windows early.
- Routed: cold — Testing — test the new CLI against the older Tower's shapes.
- Routed: cold — Testing — to claim "unchanged" or "no slower", commit the record of before
  ahead of the change; compare medians of several runs with the load noted.
- No change to the hot file `lessons-critical.md`. It is at its cap, and each of these is a
  sharper case of a lesson already there ("verify the real user path", "single source of truth").

## Flaky Tests

**Porch's local tests check, failing under the suite's own load** (issue #1956). Every failure
was a timeout in a test that starts a subprocess, in a file this project does not touch, and
every file passes when run alone. All were left running.

- Phase 1: one failure, test not identified (porch's output was cut); the suite passed twice
  after on the same code.
- Phase 2: one unidentified failure, then 92 timeouts in 17 files at a load average of 33 to 49:
  `packages/codev/src/commands/consult/__tests__/` (`claude-cli-lane`, `tripwire-wiring`,
  `agy-lane-model`, `bugfix-1754-dotenv-auth`, `lane-models`, `agy-auth-cache`),
  `packages/codev/src/__tests__/` (`doctor`, `claude-cli`, `bugfix-1455-pr-create-concept`,
  `forge`, `consult`), `packages/codev/src/agent-farm/__tests__/` (`ide-extensions`,
  `bugfix-1267-launch-loop`, `ide-version`, `pir-1233-session-launch-loop`, `ide-command`,
  `ide-server-unready`). Run alone at load 10: 586 passed, 1 skipped.
- Phase 3: five files, four of them from the list above (`bugfix-1267-launch-loop`,
  `ide-command`, `pir-1233-session-launch-loop`, `agy-auth-cache`) and
  `packages/codev/src/__tests__/windows-console-spawn-guard.test.ts`. Run alone: 76 passed.

**On Windows** (the on-demand workflow), both left running; the two failed jobs were rerun once
and passed:

- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts`. On Node 22
  (run 45311869550): "relaunches FRESH after a clean exit (per #1267) but pinned to a newly
  minted id" failed with `Command failed: …\bash.exe …/start.sh`, then `EBUSY … rmdir` in its
  `afterEach`. On Node 24 (run 45314039137, first attempt): "degrades to a prompt-replay fresh
  launch under a new id after 3 consecutive fast resume failures", the same `Command failed`.
- Vitest reported `Worker exited unexpectedly` on Node 22 (run 45314039137, first attempt) with
  all 8888 tests passing. Issue #1923 lists a worker exit among the Windows suite's
  load-dependent failures.

The architect was told of each.

## Follow-up Items

- **Stage 2, issue #1967** (between my own Towers, through Codev Cloud) and **stage 3, issue
  #1968** (another owner's Tower, by invitation), each inheriting the spec's checklist as
  written. The `devvm` hint and the "until it has an explicit name" tests belong to stage 2.
- **Issue #1605** (front door only) closes as superseded when this PR merges, and **issue
  #1633** is fixed by it; the architect closes both.
- **Issue #1966**: architect commands with a quoted argument are split on whitespace.
- **Issue #1960**: workspace routes refuse Windows UNC paths.
- **Issue #1956**: the local suite under its own load. The ci-first ruling retires with it.
- Retake the latency baseline at a load average of about 5 (one run of the test on a clean copy
  of `732ad0118`), so that before and after are measured under the same load.
- A version field on `/health` would let the CLI tell an older Tower with one cheap read, in
  place of the address-book probe.
- The unknown-architect hint could list registered architects as well as live ones.
- `afx whoami` could give a remedy when global.db cannot be opened.
- The live front door (terminal map order) and the registry's can differ after an architect
  terminal is registered again in a workspace with no `main`.
- The skeleton's `agent-farm.md` still lacks the multi-architect sections of the `codev/` copy.
- **For the verify phase**: on a Tower of this version, type the headline path with the
  installed `afx send` from one workspace's architect to a named architect in another, and paste
  the reply command back. In a workspace with two sibling architects registered in
  non-alphabetical order, restart the workspace and check they come back `main` first, then in
  registration order.
