# PIR Plan: Hydrate architect/session identity from the WELCOME frame

Issue: #1475 · Refs #1313 (PR #1330), `codev/reviews/1313-afx-send-mailbox-first-delivery.md`
(Technical Debt line 334, Follow-up line 352)

> **Revision 2** (post 3-way plan review: gemini APPROVE · codex REQUEST_CHANGES · claude
> REQUEST_CHANGES). Two blocking defects fixed in the design (§4 read-through, §5 `|| null`);
> all seven `attachShellper` sites enumerated; the trust claim corrected. Per-finding
> dispositions in **Review Response** at the end — including one rebuttal.

## Understanding

### What the issue asks for

`afx send <agent>` only delivers onto a prompt the render-gate proves empty, and the gate can
only classify a screen if it knows **which app** is running (`resolveProfile` →
CLAUDE/CODEX/AGY profile, else `null` → held `no-profile`). Today that app identity is inferred
from the **launch command** Tower recorded, not read from the session itself:

- `PtySession.command` returns `this.config.command`
  (`packages/codev/src/terminal/pty-session.ts:723`), set at `createSessionRaw` time.
- Across a Tower restart it is restored from `terminal_sessions.command` — migration v16,
  `packages/codev/src/agent-farm/db/index.ts:575-598` — with `?? restartOptions?.command` as the
  legacy self-heal for pre-v16 rows (`servers/tower-terminals.ts:786` and `:1004`).
- `resolveProfileForSession` (`servers/mailbox-wiring.ts:162-168`) resolves from that command,
  falling back to reading `.builder-start.sh` for wrapped builder launches.

The **WELCOME frame** — the shellper's handshake reply, encoded at
`terminal/shellper-process.ts:371-381`, parsed at `terminal/shellper-client.ts:217-247` — is sent
by the process that actually owns the PTY, on every connect *and reconnect*. It is the
authoritative statement of what is running. It currently carries `version, pid, cols, rows,
startTime, lastDataAt?, alwaysSendsReplay?` (`shellper-protocol.ts:73-104`) — **not** the
command/args. This issue asks to add them and consume them, keeping the persisted-`command` SSOT
+ self-heal as the fallback.

### Verification of the issue's claims against current `main`

The issue body was written 2026-08-17; I re-checked every claim against the branch base
(`c2db0d70d`, off `main` @ `9129ab81c`). All still hold — nothing on `main` since has touched
this seam (the most recent commits to these files are the #1313 merge and PIR #1354's mirror
seeding; `f0fa43afe` renamed `afx reset` → `afx refresh`, which does not touch identity):

| Claim | Status |
|---|---|
| Identity is command-derived, persisted via migration v16 | ✅ `db/index.ts:575-598` |
| Legacy self-heal on restart | ✅ `?? restartOptions?.command`, `tower-terminals.ts:786`, `:1004` |
| WELCOME does not carry identity | ✅ `WelcomeMessage`, `shellper-protocol.ts:73-104` |
| It "needs a protocol change" | ✅ `WelcomeMessage` + shellper emit + client parse |
| The codebase itself names this the authoritative fix | ✅ `mailbox-wiring.ts:151-161` — *"the day codex/claude markers diverge, stale identity becomes a live bug and the authoritative fix is WELCOME-frame hydration"* |

### The drift this closes — calibrated

Reviewers correctly pushed back on revision 1's framing. The honest statement:

1. **Legacy-row heal can be wrong (live, today).** For a pre-v16 row (`command` NULL), reconcile
   substitutes `restartOptions.command`, built from the **current** config/env
   (`TOWER_ARCHITECT_CMD` > `config.shell.architect` > `'claude'`, `tower-terminals.ts:946-960`).
   A long-lived architect PTY launched under the *old* config and adopted after a config edit gets
   healed to the *new* harness while the live process is still the old one.
2. **Wrappers / renamed harnesses (live, today).** Identity is what Tower *asked for*; the
   shellper knows what it *ran*.
3. **In-flight relaunches — a structural hazard, NOT a live drift.** `SessionManager` re-`spawn()`s
   the PTY through the shellper on the #1149 crash-loop fallback (`session-manager.ts:1304-1319`,
   spawn at `:1283`) and the #1264 clean-exit rerun (`:1183-1218`, spawn at `:1211`). Both swap
   **args and env only** — `session.options.command` is never mutated, and the #1338 comment at
   `:1187-1188` says `next()` cannot change the command. Since `resolveProfile` reads only
   `identity.command` (`gate-profiles.ts:129-135`), these seams change nothing about *resolved*
   identity today. The fix covers them because it is free, not because they are broken.

Why any of it matters is unchanged: the fail-safe that makes stale identity survivable is the
CLAUDE/CODEX-profiles-are-identical accident that `mailbox-wiring.ts:151-161` itself flags.

Deliberate non-goal: a **builder** shellper genuinely spawned `/bin/bash [<abs>/.builder-start.sh]`
(`commands/spawn.ts:686-689`), so WELCOME reports the wrapper — identical to today, with the
`harnessFromLaunchScript` backstop still carrying it. Hydration must not regress that path.

## Proposed Change

Add identity to the WELCOME frame as **optional fields** and consume them with a strict
precedence: **WELCOME → persisted `command` → legacy self-heal**. Six thin layers, one PR.

### 1. Protocol — `terminal/shellper-protocol.ts:73-104`

Add to `WelcomeMessage`:

```ts
command?: string;   // argv[0] the shellper actually spawned the PTY with
args?: string[];    // its argv[1..]
```

**No `PROTOCOL_VERSION` bump.** `ShellperClient` *rejects* a shellper whose version is lower than
Tower's (`shellper-client.ts:223-227`), so bumping would disconnect every live pre-upgrade
shellper on the first Tower restart after the upgrade — killing running architect and builder
sessions. Additive-optional-field is the established compatible-extension pattern here, used by
both `lastDataAt` (#1198-era) and `alwaysSendsReplay` (#1215), whose comment states the rationale
verbatim.

### 2. Shellper — `terminal/shellper-process.ts`

Record the argv in `spawnPty()` (`:127-147`) into `this.ptyCommand` / `this.ptyArgs`. That single
site covers **both** entry points — initial `start()` (`:123`) and the SPAWN-frame replacement
(`:477`) — so a relaunched PTY reports its *new* argv on the next WELCOME rather than the
original. Include both in the `encodeWelcome` payload (`:371-381`) and in the WELCOME log line.

### 3. Client — `terminal/shellper-client.ts`

Hydrate `_welcomeCommand: string | null` / `_welcomeArgs: string[] | null` in the WELCOME branch
(`:236-248`, alongside `lastDataAt` / `alwaysSendsReplay`), defaulting to `null` when absent
(legacy shellper).

**Atomic accept/reject.** The pair is one capability: accept only when `command` is a non-empty
(post-`trim`) string within a length bound **and** `args`, if present, is an array of strings
within count/length bounds. Anything else → **both** `null`, fall back to config. This rules out
`''` overwriting a good value, a mixed valid-command/garbage-args pair, and an oversized payload.

Expose as `readonly welcomeCommand?: string | null` / `welcomeArgs?: string[] | null` — **optional**
on `IShellperClient`, required on the concrete `ShellperClient`. Optional is deliberate: the one
real implementor, `MockShellperClient` in
`terminal/__tests__/tower-shellper-integration.test.ts:21`, uses a genuine `implements` clause and
would otherwise fail typecheck, while five other doubles use `as unknown as IShellperClient` and
would silently yield `undefined` rather than `null` at runtime. Optional members + a falsy
fallback in the getters make both cases correct without touching six test files.

Also refresh the fields in `spawn()` (`:342-345`) — Tower issues that SPAWN itself, so the client
keeps its authoritative record current without waiting for a reconnect. The update must sit
**after** the `if (!this._connected || !this.socket) return;` guard and after the socket write, or
the client records an argv the shellper never received.

### 4. Session — `terminal/pty-session.ts` — **read-through, not snapshot**

The getters (`:723`, `:728`) read the live client on every access:

```ts
private get hydratedIdentity(): { command: string; args: string[] } | null {
  const command = this.shellperClient?.welcomeCommand;
  if (!command) return null;                     // falsy covers null | undefined | ''
  return { command, args: this.shellperClient?.welcomeArgs ?? [] };
}
get command(): string { return this.hydratedIdentity?.command ?? this.config.command; }
get launchArgs(): string[] { return this.hydratedIdentity?.args ?? this.config.args; }
```

A copy taken at `attachShellper` would go stale: an ordinary SPAWN relaunch replaces the PTY
**without** a socket reconnect, so `attachShellper` never re-runs. Read-through needs no new
state — `attachShellper` already sets `this.shellperClient` (`:233`) and `detachShellper` nulls it
(`:403-407`), so degradation to config is automatic. Keying `launchArgs` off the same
`hydratedIdentity` preserves the atomicity of §3 at the read side (a legitimately empty argv stays
`[]` rather than falling back to config).

Non-shellper (local node-pty) sessions are unaffected — `config.command` *is* what was spawned.

Add `get identitySource(): 'welcome' | 'config'` so the fallback is observable, not inferred.

### 5. Persist-back — one mechanism per site, and never `''`

**Two rules, both load-bearing:**

- **Write `ptySession.command || null`, never the raw getter.** `createSessionRaw` defaults
  `command: opts.command ?? ''` (`pty-manager.ts:156`), so a legacy NULL row + legacy shellper
  yields `''`. Since the heal is `dbSession.command ?? restartOptions?.command` and `'' ?? x` is
  `''` (`??` catches only null/undefined), persisting `''` would convert a **healable NULL into a
  permanently unhealable empty string** — a regression introduced in the exact path #1313 fixed.
- **One mechanism per site.** At the reconcile sites the row is `DELETE`d and re-saved
  (`tower-terminals.ts:832-835`), so an `updateTerminalCommand` written at attach time would be
  silently wiped 35 lines later. Use `saveTerminalSession` where a save already follows the attach;
  use the new `updateTerminalCommand(terminalId, command | null)` helper (mirroring
  `updateTerminalLabel`, `tower-terminals.ts:325-331`) **only** where no save follows.

All **seven** production `attachShellper` sites, classified:

| Site | Kind | Persist-back |
|---|---|---|
| `tower-terminals.ts:797` (startup adoption) | reconnect to live shellper | `saveTerminalSession` at `:833-835` with `ptySession.command \|\| null` |
| `tower-terminals.ts:1011` (on-the-fly reconnect) | reconnect to live shellper | `saveTerminalSession` at `:1049-1051`, same |
| `tower-server.ts:541` (`session-reconnected`, #1198) | **in-place re-attach of a freshly connected client — no save follows** | **`updateTerminalCommand`** — this is why the helper exists |
| `tower-instances.ts:644` (main architect fresh launch) | fresh spawn | `saveTerminalSession` at `:652-653`; hydration is a **no-op** (Tower just spawned it) — routed through the same code path for uniformity |
| `tower-instances.ts:1165` (sibling architect fresh launch) | fresh spawn | same; no-op |
| `tower-routes.ts:821` (persistent builder/shell create) | fresh spawn | same; no-op |
| `tower-routes.ts:2953` (persistent session create) | fresh spawn | same; no-op |

The four no-op sites are listed explicitly so a reader can see they were considered, not missed.

`createSessionRaw`'s existing `dbSession.command ?? restartOptions?.command ?? undefined` seed at
`:786` / `:1004` **stays** — it runs before the attach and is precisely the fallback when hydration
is unavailable.

### 6. Comment + docs truth-up

- `mailbox-wiring.ts:143-168` — the "Stale-identity note" names WELCOME hydration as the *pending*
  authoritative fix; rewrite it to describe the shipped precedence chain, keeping the honest caveat
  that a wrapped launch still resolves via `.builder-start.sh`.
- `pty-manager.ts:146-155` — the standing invariant comment says *"`args` is CREATION-ONLY … A
  reconnected session gets `[]`. Do not make args a resolution input … without adding matching
  persistence."* Hydration makes the factual half false (a reconnected session now gets the
  shellper's real argv). Update it to say so, and keep the rule: `args` is still **not** a
  resolution input (`resolveProfile` reads only `identity.command`) and still not persisted; if we
  ever want it to be, WELCOME hydration — not the row — is the way to satisfy the invariant.
- `codev/resources/arch.md:206` — "WELCOME (pid, cols, rows, startTime)" → include the identity
  fields. No `codev-skeleton/` mirror: the wire protocol is package internals and
  `codev-skeleton/resources/commands/agent-farm.md` does not document WELCOME (grepped: zero hits).

## Files to Change

- `packages/codev/src/terminal/shellper-protocol.ts:73-104` — `command?` / `args?` on
  `WelcomeMessage` with the backward-compat rationale (no version bump)
- `packages/codev/src/terminal/shellper-process.ts:127-147, 371-383` — record argv in `spawnPty`,
  emit in WELCOME
- `packages/codev/src/terminal/shellper-client.ts:50-70, 100-140, 236-248, 342-345` — optional
  interface members, backing fields, atomic bounded validation, post-guard `spawn()` refresh
- `packages/codev/src/terminal/pty-session.ts:716-730` — read-through getters + `identitySource`
- `packages/codev/src/terminal/pty-manager.ts:146-155` — invariant comment truth-up
- `packages/codev/src/agent-farm/servers/tower-terminals.ts:325, 833-835, 1049-1051` —
  `updateTerminalCommand` helper; hydrated `|| null` persist at both reconcile saves
- `packages/codev/src/agent-farm/servers/tower-server.ts:530-543` — `updateTerminalCommand` on
  `session-reconnected`
- `packages/codev/src/agent-farm/servers/tower-instances.ts:644-653, 1165` and
  `servers/tower-routes.ts:821, 2953` — hydrated value into the existing saves (no-op sites)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:143-168` — stale-identity note rewrite
- `codev/resources/arch.md:206` — handshake carries identity
- **New** `packages/codev/src/terminal/__tests__/welcome-identity.test.ts`
- **New** `packages/codev/src/agent-farm/__tests__/pir-1475-welcome-identity.test.ts`
- `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts:250-260` — the source
  guard counts `dbSession.command ?? restartOptions?.command` and expects **4**; this change leaves
  2 (the `createSessionRaw` seeds) and replaces the other 2 with the hydrated persist. Update to 2
  **and** add a positive assertion for the new persist pattern, so the guard keeps its teeth.
- `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts` — no change expected
  (optional interface members), listed because it is the only real `implements IShellperClient`
- `codev/state/pir-1475_thread.md` — builder log (committed with the PR)

## Risks & Alternatives Considered

- **Risk: a version bump would kill live sessions.** Mitigated by the optional-field pattern (§1).
  A test pins `PROTOCOL_VERSION === 1` with a comment reading *"this change must not bump it"* —
  so a legitimate future bump fails with a readable reason, not an opaque assert.
- **Risk: persist-back destroys the legacy self-heal.** The `|| null` rule in §5, with a dedicated
  legacy-NULL-round-trip test.
- **Risk: hydration makes identity worse somewhere.** Only possible if the shellper's argv is less
  informative than the row. The known case is the wrapped builder launch, where both are
  `/bin/bash [<abs>/.builder-start.sh]` and the launch-script backstop already handles it. Explicit
  no-regression test using that real shape.
- **Risk (corrected): a garbled WELCOME command.** Revision 1 claimed a bogus value "cannot cause
  misdelivery, only `no-profile`". **That was wrong.** `resolveProfile` matches by *substring* —
  `basename.includes('agy')` (`gate-profiles.ts:131`) and `detectHarnessFromCommand`'s
  `includes('claude'|'codex'|…)` (`utils/harness.ts:437-440`) — so a garbled string containing
  `claude` resolves a **real** profile. The fail-safe mostly holds only via the
  CLAUDE/CODEX-identical accident plus cross-family marker mismatch, which is a property of the
  current profile table, not of parsing. What we actually rely on: the payload arrives over an
  owner-only socket (`chmod 0600`, `shellper-process.ts:221-225`) inside the `0700` run dir, from a
  PID/start-time-validated shellper. Mitigation is therefore atomic bounded validation (§3) plus a
  test pinning what a garbled-but-recognizable command does today.
- **Risk: persist-back thrash.** Writes only on difference; steady-state Tower writes once per
  session at most.
- **Alternative: bump `PROTOCOL_VERSION`, make the fields required.** Rejected — §1; the
  disconnect-on-older-version rule makes it actively destructive.
- **Alternative: shellper reports the *resolved* harness name.** Rejected — it would put
  app-classification policy in the shellper, which is deliberately dependency- and policy-free
  (`shellper-protocol.ts:7-10`); the strict profile table (`gate-profiles.ts` constraint 10) stays
  Tower-side.
- **Alternative: resolve through wrappers (`env FOO=1 claude` → `claude`).** Out of scope — a
  pre-existing `resolveProfile` limitation, unchanged here.

## Test Plan

**Unit — protocol / shellper / client** (`welcome-identity.test.ts`)
- `encodeWelcome`/parse round-trips `command` + `args`; a payload omitting them parses with both
  `undefined` (legacy shellper).
- **Both mixed-version directions**: new Tower + fieldless old-shellper WELCOME → handshake
  completes, fields `null`; old-Tower parse of an *extended* WELCOME → extra keys ignored,
  handshake completes.
- `ShellperProcess` sends its spawned argv on WELCOME; after a SPAWN frame replaces the PTY, the
  next WELCOME carries the new argv.
- `ShellperClient` hydration: valid pair accepted; **atomic rejection** for `command: 42`,
  `command: ''`, `command: '   '`, `args: 'x'`, `args: [1,2]`, oversized command, oversized args —
  each leaves **both** fields `null`.
- `client.spawn({command:'codex',…})` updates `welcomeCommand`/`welcomeArgs` immediately (no
  reconnect), and does **not** when the client is disconnected (post-guard placement).
- `PROTOCOL_VERSION` is unchanged and a fieldless WELCOME still completes the handshake.

**Unit — session + delivery seam** (`pir-1475-welcome-identity.test.ts`)
- Read-through: `PtySession.command`/`launchArgs` reflect WELCOME after attach
  (`identitySource === 'welcome'`); with a legacy/`as unknown as` double they fall back to config
  and report `'config'`; after `detachShellper` they fall back again.
- **The test that would have caught the revision-1 snapshot bug**: attach, then drive a SPAWN
  relaunch through the *real* `SessionManager` paths (clean-exit rerun and crash-loop fallback)
  and assert `PtySession.command`/`launchArgs` change immediately — with **no** re-attach and no
  reconnect.
- **Headline**: a session created with a *wrong* persisted command whose shellper reports `agy`
  resolves `AGY_PROFILE` through the real `resolveProfileForSession` (today it resolves the wrong
  profile). Same shape for a row NULL-healed to `codex` while the process is `claude`.
- **Legacy round trip (blocking-fix pin)**: legacy NULL row + legacy shellper → after reconcile
  the row is **still NULL**, not `''`, and the self-heal still fires on the next restart.
- **No regression**: builder session with the real shape `/bin/bash` + `[<abs>/.builder-start.sh]`
  still resolves via `harnessFromLaunchScript`.
- Persist-back per site: hydrated value lands via `saveTerminalSession` at both reconcile sites;
  lands via `updateTerminalCommand` on `session-reconnected` (in-place re-attach, no save follows);
  no write when the value already matches.
- Trust: a garbled-but-recognizable command (e.g. `not-really-claude-xyz`) — assert the *actual*
  current behavior (resolves CLAUDE_PROFILE via substring match) so the seam is documented rather
  than assumed fail-safe.

**Suite**: full `vitest` must stay green (4551-passing #1313 baseline). The #1313 identity suites
(`send-architect-identity`, `spec-1313-migration`, `spec-1313-registry-resolve`) are the regression
guard for the fallback path; `send-architect-identity`'s source guard is updated deliberately
(above), not made to pass.

**Manual (dev-approval gate — reviewer runs the worktree)**
1. `afx dev` on this branch; open Tower, launch an architect.
2. `afx send architect "ping"` → `delivered` (baseline, unchanged).
3. Tower log shows `identity hydrated from WELCOME: command=claude (row: claude)` — the
   authoritative path is the one in use, not the fallback.
4. Restart Tower → reconcile adopts the live shellper → `afx send architect "ping again"` →
   `delivered`, source still `welcome`. (This is the exact path #1313 fixed fail-closed.)
5. **Relaunch without restart**: quit the architect harness cleanly (double Ctrl-C) so #1264 reruns
   it via SPAWN; without restarting Tower, `afx send architect "post-relaunch"` → `delivered`, and
   the log shows identity read through the live client.
6. Legacy-fallback check: a client without the fields → log shows `identitySource=config`, delivery
   still works — the fallback is intact, which is the issue's explicit requirement.
7. Builder check: spawn a throwaway builder, `afx send <id> "ping"` → `delivered` via the
   launch-script backstop (no regression on the wrapped path).

**Cross-platform**: N/A (Linux/macOS Node + Unix sockets; no mobile/web surface).

## Review Response

Verdicts: gemini **APPROVE** · codex **REQUEST_CHANGES** · claude **REQUEST_CHANGES**. I verified
every finding against source before acting on it.

| # | Finding | Disposition |
|---|---|---|
| 1 | **Blocking** — snapshot-at-attach goes stale across SPAWN (all three lanes) | **Addressed** — §4 read-through getters; test drives both real relaunch paths. Calibration folded into *The drift this closes* (§3 of that list): relaunches swap args/env only, so this closes a structural hazard, not a live drift. |
| 2 | **Blocking** — persist-back writes `''`, killing the legacy self-heal | **Addressed** — §5 `\|\| null` rule + legacy-NULL-round-trip test. Verified: `pty-manager.ts:156` defaults to `''`, and `'' ?? x` is `''`. |
| 3 | 7 `attachShellper` sites, plan covered 3 | **Addressed** — all seven enumerated in §5 with kind + mechanism; the four no-op fresh-launch sites named explicitly. `tower-server.ts:541` is now where `updateTerminalCommand` earns its existence. |
| 4 | Two persist-back mechanisms collide at the reconcile sites | **Addressed** — one mechanism per site; `saveTerminalSession` where a save follows (the row is DELETEd at `:832`), `updateTerminalCommand` only where none does. |
| 5 | Interface change breaks `tower-shellper-integration.test.ts:21`; "structural" claim wrong | **Addressed** — members declared **optional** on `IShellperClient`, falsy fallback in the getters. Verified: that file uses a real `implements`; five other doubles use `as unknown as`, yielding `undefined` not `null`. |
| 6 | Trust-boundary claim overstated; socket is 0600 not 0700 | **Addressed** — risk rewritten with the substring-matching reality (`gate-profiles.ts:131`, `harness.ts:437-440`), atomic bounded validation, correct `0600` file mode inside the `0700` dir, and a test pinning the garbled-but-recognizable case. |
| 7 | `pty-manager.ts:146-155` invariant comment invalidated | **Addressed** — §6; the factual half is corrected, the rule kept (args still not a resolution input, still not persisted). |
| 8 | `send-architect-identity.test.ts` source guard expects 4 | **Addressed** — Files to Change; updated to 2 **plus** a positive assertion on the new persist pattern, deliberately, not made-to-pass. |
| — | **Codex #3 — SPAWN-time row persistence** | **Rebutted, with a test.** After a relaunch the row *can* hold the pre-relaunch command. That staleness is **never observable**: `terminal_sessions.command` is read at exactly two places (`tower-terminals.ts:786/835`, `:1004/1051`), both reconcile paths that attach a freshly-connected client whose WELCOME supersedes the row and then persist the corrected value. Live identity is already correct the instant SPAWN lands (§3 `spawn()` refresh + §4 read-through). The natural hooks would not work anyway: `session-fresh-restart` (`:1207`) and `session-restart` (`:1273`) both fire *before* the delayed `client.spawn()` inside `setTimeout`, so persisting there would record an argv that has not been sent. Rather than add event plumbing from `terminal/` into the DB layer for an unobservable value, the plan pins the property with a test: post-SPAWN row may be stale → reconcile re-hydrates from WELCOME → persist-back corrects it. If the row ever becomes authoritative for something else, this reopens. |
| — | Nits (empty/whitespace → null; post-guard `spawn()` update; real builder launch shape; commented version tripwire; extra tests incl. both mixed-version directions, `client.spawn()` immediacy, `session-reconnected` persistence, clean-exit manual step) | **All taken** — folded into §3, §4, Files to Change, Test Plan, and manual step 5. |
| — | Line-ref drift noted by claude (`WelcomeMessage` is `:73-104`; crash-loop fallback `:1304-1319`, spawn `:1283`) | **Corrected** throughout; refs re-verified against the branch base rather than trusted. |
