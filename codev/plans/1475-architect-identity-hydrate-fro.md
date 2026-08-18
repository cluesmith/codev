# PIR Plan: Hydrate architect/session identity from the WELCOME frame

Issue: #1475 · Refs #1313 (PR #1330), `codev/reviews/1313-afx-send-mailbox-first-delivery.md`
(Technical Debt line 334, Follow-up line 352)

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
startTime, lastDataAt?, alwaysSendsReplay?` — **not** the command/args. This issue asks to add
them and consume them, keeping the persisted-`command` SSOT + self-heal as the fallback.

### Verification of the issue's claims against current `main`

The issue body was written 2026-08-17; I re-checked every claim against the branch base
(`c2db0d70d`, off `main` @ `9129ab81c`). All still hold — nothing on `main` since has touched
this seam (the most recent commits to these files are the #1313 merge and PIR #1354's mirror
seeding; `f0fa43afe` renamed `afx reset` → `afx refresh`, which does not touch identity):

| Claim | Status |
|---|---|
| Identity is command-derived, persisted via migration v16 | ✅ `db/index.ts:575-598` |
| Legacy self-heal on restart | ✅ `?? restartOptions?.command`, `tower-terminals.ts:786`, `:1004` |
| WELCOME does not carry identity | ✅ `WelcomeMessage`, `shellper-protocol.ts:74-102` |
| It "needs a protocol change" | ✅ `WelcomeMessage` + shellper emit + client parse |
| The codebase itself names this the authoritative fix | ✅ `mailbox-wiring.ts:151-161` — *"the day codex/claude markers diverge, stale identity becomes a live bug and the authoritative fix is WELCOME-frame hydration"* |

### The drift this actually closes (concrete, not hypothetical)

1. **Legacy-row heal can be wrong.** For a pre-v16 row (`command` NULL), reconcile substitutes
   `restartOptions.command`, which is built from the **current** config/env
   (`TOWER_ARCHITECT_CMD` > `config.shell.architect` > `'claude'`,
   `tower-terminals.ts:946-960`). A long-lived architect PTY launched under the *old* config and
   adopted after a config edit gets healed to the *new* harness while the live process is still
   the old one. Fail-closed today only because `CLAUDE_PROFILE` and `CODEX_PROFILE` are
   behaviourally identical — an accident of the current profile table, as the comment says.
2. **Wrappers / renamed harnesses.** Identity comes from what Tower *asked for*; the shellper
   knows what it *ran*.
3. **In-flight relaunches.** `SessionManager` re-`spawn()`s the PTY through the shellper with
   swapped args on the #1149 crash-loop fallback (`session-manager.ts:1305-1320`) and the #1264
   clean-exit fresh launch (`session-manager.ts:1183-1218`). Tower's persisted row is not
   rewritten; only the shellper knows the current argv.

Note the deliberate non-goal: for a **builder**, the shellper genuinely spawned
`bash .builder-start.sh`, so WELCOME reports the wrapper — identical to today, and the
`harnessFromLaunchScript` backstop still carries it. Hydration must not regress that path.

## Proposed Change

Add identity to the WELCOME frame as **optional fields** and consume them with a strict
precedence: **WELCOME → persisted `command` → legacy self-heal**. Six thin layers, one PR.

### 1. Protocol — `terminal/shellper-protocol.ts`

Add to `WelcomeMessage`:

```ts
command?: string;   // argv[0] the shellper actually spawned the PTY with
args?: string[];    // its argv[1..]
```

**No `PROTOCOL_VERSION` bump.** `ShellperClient` *rejects* a shellper whose version is lower than
Tower's (`shellper-client.ts:223-227`), so bumping the constant would disconnect every live
pre-upgrade shellper on the first Tower restart after the upgrade — killing running architect and
builder sessions. Additive-optional-field is the established compatible-extension pattern here,
used by both `lastDataAt` (#1198-era) and `alwaysSendsReplay` (#1215), and the #1215 comment
states the rationale explicitly: advertise capabilities in the payload, not via the version.

### 2. Shellper — `terminal/shellper-process.ts`

Record the argv in `spawnPty()` (`:127-147`) into `this.ptyCommand` / `this.ptyArgs`. That single
site covers **both** entry points — initial `start()` (`:123`) and the SPAWN-frame replacement
(`:477`) — so a relaunched PTY reports its *new* argv on the next WELCOME rather than the
original. Include both in the `encodeWelcome` payload (`:371-381`) and in the WELCOME log line.

### 3. Client — `terminal/shellper-client.ts`

Hydrate into `_welcomeCommand: string | null` / `_welcomeArgs: string[] | null` in the WELCOME
branch (`:236-248`, alongside the existing `lastDataAt` / `alwaysSendsReplay` hydration), defaulting
to `null` when absent (legacy shellper). Expose as `readonly welcomeCommand` / `welcomeArgs` on
`ShellperClient` **and on the `IShellperClient` interface** (`:50-70`) — `PtySession` and the
tests type against the interface, and the existing test doubles (e.g. `FakeShellper` in
`send-architect-identity.test.ts`) implement it structurally.

Also update the fields in `spawn()` (`:342`): Tower itself issues that SPAWN, so the client can
keep its authoritative record current without waiting for a reconnect. Validate shape defensively
(`typeof === 'string'`, `Array.isArray` with string elements) — the payload is JSON off a socket.

### 4. Session — `terminal/pty-session.ts`

`attachShellper` (`:216`) captures `client.welcomeCommand` / `welcomeArgs` into
`_hydratedCommand` / `_hydratedArgs`. The `command` (`:723`) and `launchArgs` (`:728`) getters
return the hydrated value when present, else `this.config.command` / `this.config.args`.
Non-shellper (local node-pty) sessions are unaffected — for those `config.command` *is* what was
spawned, so it stays authoritative.

Add `get identitySource(): 'welcome' | 'config'` for logging and tests — the fallback must be
observable, not inferred.

### 5. Persist-back — `servers/tower-terminals.ts`, `servers/tower-instances.ts`

After each `attachShellper`, if the hydrated command differs from what the row holds, write it
back so the **fallback SSOT self-corrects** for the next restart, and log the correction. New
helper `updateTerminalCommand(terminalId, command)` mirroring the existing
`updateTerminalLabel` (`tower-terminals.ts:325-331`).

The two reconcile sites already persist a row right after attach — pass the post-attach
`ptySession.command` instead of `dbSession.command ?? restartOptions?.command ?? null`:

- startup adoption: attach `:800`, save `:833-835`
- on-the-fly reconnect: attach `:1013`, save `:1049-1051`
- fresh architect launch: attach `:643`, save `tower-instances.ts:652-653` (hydration is a no-op
  here — Tower just spawned it — but keeps one code path)

### 6. Comment + docs truth-up

`mailbox-wiring.ts:150-161`'s "Stale-identity note" names WELCOME hydration as the pending
authoritative fix; rewrite it to describe the shipped precedence chain (and keep the honest
caveat that a *wrapped* launch still resolves via `.builder-start.sh`). Update the handshake
description in `codev/resources/arch.md:206` — "WELCOME (pid, cols, rows, startTime)" — to include
the identity fields. No `codev-skeleton/` mirror: the wire protocol is package internals, and
`codev-skeleton/resources/commands/agent-farm.md` does not document WELCOME (grepped: no hits).

## Files to Change

- `packages/codev/src/terminal/shellper-protocol.ts:74-102` — add `command?` / `args?` to
  `WelcomeMessage` with the backward-compat rationale (no version bump)
- `packages/codev/src/terminal/shellper-process.ts:127-147, 371-383` — record argv in `spawnPty`,
  emit it in WELCOME
- `packages/codev/src/terminal/shellper-client.ts:50-70, 100-140, 236-248, 342` — interface
  members, backing fields, WELCOME hydration with shape validation, SPAWN refresh
- `packages/codev/src/terminal/pty-session.ts:216-235, 716-730` — capture on attach; getters prefer
  hydrated; `identitySource`
- `packages/codev/src/agent-farm/servers/tower-terminals.ts:325, 786-835, 1004-1051` —
  `updateTerminalCommand`; persist the hydrated command at both reconcile sites
- `packages/codev/src/agent-farm/servers/tower-instances.ts:637-653` — same at the fresh-launch site
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts:143-168` — rewrite the stale-identity note
- `codev/resources/arch.md:206` — handshake now carries identity
- **New** `packages/codev/src/terminal/__tests__/welcome-identity.test.ts` — protocol/shellper/client layers
- **New** `packages/codev/src/agent-farm/__tests__/pir-1475-welcome-identity.test.ts` — the
  delivery-seam test (stale row + truthful WELCOME → right profile) and the persist-back
- Extend `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts` — its
  `FakeShellper` gains the new interface members; add the no-regression legacy case
- `codev/state/pir-1475_thread.md` — builder log (committed with the PR)

## Risks & Alternatives Considered

- **Risk: a version bump would kill live sessions.** Mitigated by the optional-field pattern
  (§1). A test asserts `PROTOCOL_VERSION === 1` stays put and that a WELCOME *without* the fields
  still handshakes.
- **Risk: hydration makes identity *worse* somewhere.** The only way is if the shellper's argv is
  less informative than the row. The known such case is the wrapped builder launch — where both
  are `bash .builder-start.sh` and the launch-script backstop already handles it. Covered by an
  explicit no-regression test.
- **Risk: a hostile/garbled WELCOME payload injects a bogus command.** The socket is
  `0700`-mode and local, but the parse is defensive anyway (type checks; a non-string `command`
  is ignored → fall back). A bogus value cannot cause misdelivery, only an unmatched profile →
  held `no-profile`, which is the fail-safe direction.
- **Risk: persist-back thrash.** Writes only on difference, so a steady-state Tower writes once
  per session at most.
- **Alternative: bump `PROTOCOL_VERSION` and make the fields required.** Rejected — §1; the
  disconnect-on-older-version rule makes it actively destructive.
- **Alternative: have the shellper report the *resolved* harness name (`claude`/`codex`/`agy`)
  rather than raw argv.** Rejected — it would put app-classification policy in the shellper, which
  is deliberately dependency-free and policy-free (`shellper-protocol.ts:7-10`); the strict
  profile table (`gate-profiles.ts` constraint 10) must stay Tower-side.
- **Alternative: resolve through wrappers (`env FOO=1 claude` → `claude`).** Out of scope — it is a
  pre-existing limitation of `resolveProfile`, unchanged by this work; noted, not fixed.

## Test Plan

**Unit — protocol/shellper/client** (`welcome-identity.test.ts`)
- `encodeWelcome`/parse round-trips `command` + `args`; a payload omitting them parses with both
  `undefined` (legacy shellper).
- `ShellperProcess` sends its spawned argv on WELCOME; after a SPAWN frame replaces the PTY, the
  **next** WELCOME carries the new argv.
- `ShellperClient` hydrates `welcomeCommand`/`welcomeArgs`; a legacy WELCOME leaves them `null`;
  a malformed payload (`command: 42`, `args: 'x'`) is ignored rather than adopted.
- `PROTOCOL_VERSION` is unchanged and a fieldless WELCOME still completes the handshake.

**Unit — session + delivery seam** (`pir-1475-welcome-identity.test.ts`)
- `PtySession.command`/`launchArgs` return the WELCOME values after `attachShellper`;
  `identitySource === 'welcome'`. With a legacy client they fall back to `config` and report
  `'config'`.
- **Headline:** a session created with a *wrong* persisted command whose shellper reports `agy`
  resolves `AGY_PROFILE` through the real `resolveProfileForSession` — today it resolves the
  wrong profile. Same shape with the row NULL-healed to `codex` while the process is `claude`.
- **No regression:** a builder session (`command: 'bash'`, WELCOME `bash .builder-start.sh`) still
  resolves via `harnessFromLaunchScript`.
- Persist-back: after reconcile-with-attach, `terminal_sessions.command` holds the hydrated value;
  no write when it already matches.

**Suite**: full `vitest` run must stay green (4551-passing baseline from #1313); the #1313 identity
suites (`send-architect-identity`, `spec-1313-migration`, `spec-1313-registry-resolve`) are the
regression guard for the fallback path.

**Manual (dev-approval gate — reviewer runs the worktree)**
1. `afx dev` on this branch; open Tower, launch an architect.
2. `afx send architect "ping"` → `delivered` (baseline, unchanged).
3. Tower log shows the identity line: `identity hydrated from WELCOME: command=claude
   (row: claude)` — i.e. the authoritative path is the one being used, not the fallback.
4. Restart Tower → reconcile adopts the live shellper → `afx send architect "ping again"` →
   `delivered`, log again shows `welcome` as the source (this is the exact path #1313 fixed
   fail-closed; it must now be authoritative and still work).
5. Legacy-fallback check: point a session at a shellper build without the fields (or stub the
   client) → log shows `identitySource=config`, delivery still works — the fallback is intact,
   which is the issue's explicit requirement.
6. Builder check: spawn a throwaway builder, `afx send <id> "ping"` → `delivered` via the
   launch-script backstop (proves no regression on the wrapped path).

**Cross-platform**: N/A (Linux/macOS Node + Unix sockets; no mobile/web surface).
