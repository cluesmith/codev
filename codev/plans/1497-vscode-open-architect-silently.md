# PIR Plan: open-architect must not substitute a different architect while claiming to be `main`

Issue: #1497 · Area: `area/vscode` · Files: `apps/vscode/src/extension.ts`, `apps/vscode/src/terminal-manager.ts`

## Understanding

`codev.openArchitectTerminal` resolves an architect, then opens and caches its terminal by name.
The resolver at `extension.ts:920-922`:

```ts
const match = architects.find(a => a.name === targetName);
const fallback = targetName === 'main' ? architects[0] : undefined;
const target = match ?? fallback;
if (target?.terminalId) {
  await terminalManager?.openArchitect(target.terminalId, targetName, true); // NB: passes targetName, not target.name
```

When `targetName === 'main'` and `main` is not in the live roster (a Tower restart window, a
crashed/reattaching session, a transiently stale overview), `match` is `undefined` and the code
opens **`architects[0]`** — say `web` — while still flowing the *requested* name `'main'` onward.

**Why this is the whole defect in a few lines** — in `terminal-manager.ts` the name is an *address*
twice over:

- `terminal-manager.ts:123` — cache key: `const key = \`architect:${architectName}\``. web's terminal
  is registered under `architect:main`.
- `terminal-manager.ts:135` — label: `architectName === 'main' ? 'Codev: Architect' : \`... (${name})\``.
  Passing `'main'` renders the **unqualified** caption — the exact form that denotes `main` — so the
  one artifact that could reveal the substitution instead strips the qualifier.
- `terminal-manager.ts:152-157` — injection: `injectArchitectText(text, 'main')` does
  `terminals.get('architect:main')` and `entry.terminal.sendText(text, false)`. It finds web's
  terminal, so **any text injected at `'main'` types into web's terminal** until that cache entry is
  replaced. `codev.referenceIssueInArchitect` / `referencePRInArchitect` inherit this: they call
  `openArchitectTerminal` (which returns `'main'`) and then `injectArchitectText(text, 'main')`
  (`extension.ts:1180-1182`, `1193-1195`).

The self-correction (`terminal-manager.ts:126-133`) only fires on the *next* press with a different
`terminalId`, so the misdelivery window is "until the next press", not indefinite — real, not
overclaimed.

### Reachability (verified, from the issue thread)

This is reachable in shipped code with no new caller. #1463's **Open Architect Terminal** Stream Deck
key has a `target: 'main'` mode that relays `open-architect-terminal` with the literal name `'main'`
— precisely the argument that arms the fallback. Pressed while `main` is transiently invisible, the
user gets the wrong architect's terminal under the unqualified label, and later injection at `main`
lands there too. The #1463 review recorded this as an "accepted limitation" on the understanding that
it merely opened the wrong terminal; the label-strip and injection-capture findings mean it was
**under-described**, not accepted on complete information.

## The invariant this plan holds

> **No terminal is ever cached under `architect:<name>` while hosting a different architect**, and no
> `injectArchitectText(text, name)` can reach a terminal whose true occupant is not `name`.

The `|| 'main'` convenience is harmless while a name is a *caption* and harmful the moment it becomes
an *address*. The fix holds this invariant structurally, independent of the policy choice below.

## Proposed change

Two parts. Part A is the structural safeguard (holds the invariant under any policy). Part B is the
policy decision (what to do when `main` is not live).

### Part A — flow the resolved occupant's *own* name onward (structural)

Change the `openArchitect` call to pass `target.name`, not the requested `targetName`, and return
`target.name`:

```ts
const target = resolveArchitectTarget(architects, targetName);
if (target?.terminalId) {
  await terminalManager?.openArchitect(target.terminalId, target.name, true);
  return target.name;
}
vscode.window.showWarningMessage(`Codev: No '${targetName}' architect found — is the workspace activated?`);
return undefined;
```

This makes the cache key, the label, and the injection-lookup name always equal the terminal's
*actual* occupant — so misdelivery is impossible **even if** some future edit re-introduces a
fallback. The warning keeps `targetName` (what the user asked for): "No 'main' architect found".

### Part B — refuse when `main` is not live (policy: no substitution)

`resolveArchitectTarget` is a pure resolver with **no fallback**:

```ts
export function resolveArchitectTarget(
  architects: { name: string; terminalId?: string }[],
  targetName: string,
): { name: string; terminalId?: string } | undefined {
  return architects.find(a => a.name === targetName);
}
```

When `main` is not live, `target` is `undefined`, so the code takes the existing
`showWarningMessage(...)` path and returns `undefined`. `referenceIssueInArchitect` /
`referencePRInArchitect` then see a falsy `resolvedName` and skip injection entirely
(`extension.ts:1181`, `1194`) — text lands nowhere, and the user sees a legible "No 'main' architect
found — is the workspace activated?".

**Why refuse — and why this deliberately matches sibling lane pir-1494 rather than diverging.**

The architect kickoff flagged that pir-1494 answers the same "fall back to `main`?" question for the
gate-approval relay by **refusing** (`refuse-unknown-owner`, `refuse-offline`), and asked me to make
this lane's choice deliberate: substitute-under-own-name (Option B, below) *or* refuse, with the
divergence (or non-divergence) argued rather than inherited. The kickoff's own read — and main's — was
that the two paths *may* legitimately differ: an approval relay carries a human's authorization and
has no safe alternate recipient, whereas opening a terminal is recoverable and the human is looking
straight at it.

I tested that reasoning and concluded **the two lanes should NOT diverge — this path should refuse
too** — on an argument the recoverability framing does not answer:

1. **The fallback has no healthy execution path.** `targetName === 'main' ? architects[0]` is only
   ever consulted when `match` is `undefined`, i.e. when `main` is *absent* from the roster. In a
   healthy workspace the resolved architect *is* `main`, so `match` wins and the fallback never runs.
   The fallback is therefore not a feature with a buggy edge; its entire realized behaviour is the
   failure window. Removing it costs no legitimate behaviour. (The default `main` seat cannot be
   permanently removed — `extension.ts:1023-1024` refuses to remove it — so a lone non-`main`
   architect is itself a transient failure state, not a configuration to serve.)
2. **Caller intent.** The only paths that reach the fallback are the #1463 deck key (`target: 'main'`)
   and the no-arg single-architect default (`extension.ts:916`). Both mean "give me `main`", none
   mean "give me whoever is around". A request for `main` that cannot be honoured is best answered by
   saying so.
3. **Convention convergence.** This lane exists *because* a `|| 'main'` convention rotted. Two lanes
   answering the same question two different ways, with no recorded reason, is how the next one rots.
   Re-converging on "refuse" is the repair; inventing a second answer is the anti-goal.
4. **Corroboration from the gate owner.** The issue thread (Amr, who owns all three gates) states
   refusing is "strictly better for the deck, because a key that reports 'no main architect' is
   legible from across the room, whereas a terminal labelled 'Codev: Architect' is not."

So the recoverability distinction the kickoff drew is *real* but it argues "refuse is cheap here" as
much as "substitute is safe here"; it supplies no positive reason to substitute, and points 1-4 do
supply a positive reason to refuse. I therefore recommend **refuse**, and record the non-divergence
here per the kickoff's instruction.

**The choice is cleanly isolated for the gate.** Because Part A already flows `target.name` onward,
switching to Option B is a **one-line** change to the resolver — add the fallback back but return the
substitute's own object:

```ts
// Option B (substitute under its OWN name + label) — NOT recommended, shown for the gate:
return architects.find(a => a.name === targetName)
  ?? (targetName === 'main' ? architects[0] : undefined);
```

With Part A in place, Option B would open web's terminal labelled **`Codev: Architect (web)`**, cache
it under `architect:web`, return `'web'`, and inject into web (correctly, visibly). The invariant
holds under either policy; only this one line changes. If the reviewer prefers B at the gate, it is a
trivial, safe switch — no test rewrite of the invariant coverage.

## Files to change

- `apps/vscode/src/extension.ts`
  - `:920-922` — replace the `match`/`fallback`/`target` triple with `resolveArchitectTarget(...)`
    (no fallback).
  - `:924-925` — pass `target.name` to `openArchitect` and `return target.name` (Part A).
  - Add and `export` the pure `resolveArchitectTarget` helper near the command (so it is unit-testable
    without activating the extension). Warning text and the `undefined` return are unchanged.
- `apps/vscode/src/terminal-manager.ts` — **no behavioural change required**; `openArchitect` and
  `injectArchitectText` already key by the name they are given. They are in scope only as the surface
  the invariant is asserted against. (If, during implement, `openArchitect`'s label/key derivation
  needs a comment to pin the invariant, that stays inside this file.)
- `apps/vscode/src/__tests__/open-architect-not-live-main.test.ts` — new regression test (below).

**Scope guard (per kickoff):** I will not touch `commands/approve.ts`, the role docs, or any protocol
prompt (pir-1494's surface), and nothing here reaches `packages/types` or Tower. If Part A's helper
proves not to be importable from `extension.ts` under the vitest `vscode` mock (extension.ts has a
deep import graph and is not imported by any existing unit test), the fallback is a **new tiny module**
`apps/vscode/src/open-architect.ts` holding just the pure helper — still within `apps/vscode`, not a
reach across lanes. I will confirm importability empirically in the implement phase and report which
shape shipped; if a third file is needed I will flag it before adding it.

## Risks & Alternatives Considered

- **Risk — the no-arg single-architect path warns during a `main` flicker.** `extension.ts:916` forces
  `targetName = 'main'` for a single-architect workspace; if `main` is momentarily absent the user now
  sees the warning instead of a (wrong) terminal. This is the correct, honest signal ("is the
  workspace activated?"), and `main` cannot be permanently removed, so there is no steady-state
  workspace this regresses. Mitigation: none needed; documented.
- **Alternative — Option B (substitute under its own name/label).** Considered and not recommended;
  reasoning under Part B. Kept a one-line switch for the gate.
- **Alternative — keep the fallback but fix only the label/name passed onward.** Rejected: it still
  hands the user `web` when they asked for `main`, silently in intent if not in caption; points 1-2
  above apply. Part A alone (without removing the fallback) would hold the *invariant* but keep the
  wrong-architect-for-main behaviour, which the issue explicitly wants gone.

## Test Plan

The dev-approval bar (from the kickoff): *a resolver returning the right name proves nothing here —
the defect is **which terminal receives text**.* The plan splits coverage into what the builder shell
can capture behaviourally and what genuinely needs the human's machine.

### Headless, behavioural (runs in the builder shell, `pnpm --filter @cluesmith/codev-vscode test`)

New file `apps/vscode/src/__tests__/open-architect-not-live-main.test.ts`, `vi.mock('vscode')` per the
established `__tests__` pattern (see `builders-architect-header-command.test.ts`,
`command-relay.test.ts`):

1. **Injection-capture (the real misdelivery seam, not a resolver spy).** Construct a real
   `TerminalManager` with fake deps (its constructor is side-effect-free). Seed its terminal map with
   a fake terminal registered under `architect:web` whose `sendText` is a recorder. Assert:
   - `injectArchitectText(ref, 'main')` returns **false** and the recorder is **never called** — text
     injected at `main` physically cannot reach web's terminal. (Criterion 3.)
   - `injectArchitectText(ref, 'web')` returns **true** and the recorder is called once with
     `(ref, false)` — a terminal is reachable only under the key matching its true occupant.
   This captures the actual `sendText` target through the real `Map` lookup, not a stub of the
   resolver.
2. **Resolve-refusal (Part B).** `resolveArchitectTarget([{name:'web',terminalId:'t'}], 'main')`
   → `undefined` (refuse, no substitution); `resolveArchitectTarget([{name:'main',terminalId:'t'}],
   'main')` → the `main` object; named lookups return their own object. Proves no mismatched name is
   ever produced to hand downstream, so nothing is ever cached under `architect:main` while hosting
   another architect. (Criteria 1, 2, 4.)
3. **Invariant guard on the call site.** Assert the command hands `openArchitect` the resolved
   occupant's own name (Part A): with a fake `terminalManager.openArchitect` recorder and a fake
   client returning `architects = [web]`, driving the resolve for `targetName='main'` results in
   `openArchitect` **not** being called and the warning shown; for `targetName='web'` (or a live
   `main`) `openArchitect` is called with a name equal to the terminal's occupant. (This is drivable
   if the command body is reachable via the exported helper + injected deps; if activating the command
   is impractical headless, this collapses into test 2 plus a source-level guard that the call passes
   `target.name`, and the live behaviour is covered by the manual demo below. I will report which
   shape shipped.)

### Human-machine (dev-approval manual round-trip) — named explicitly, cannot run in the builder shell

The end-to-end capture the kickoff will require needs live Tower PTYs and the VSCode Extension Host,
neither of which exists in the builder shell (a real `openArchitect` dials a Tower pty over a
websocket). The reviewer runs, on their machine, a workspace with a named architect (e.g. `web`) plus
`main`:

- **Bug-gone (main not live):** stop/restart so `main` is momentarily absent → invoke Open Architect
  Terminal for `main` (or press the #1463 deck key set to Main). Observe: the **warning** appears and
  **no terminal opens**. Then trigger **Reference Issue in Architect** on a backlog row. Observe: the
  reference text appears in **no terminal** — specifically not in `web`'s. (Pre-fix: web's terminal
  opens under the bare "Codev: Architect" label and receives the text.)
- **Positive path (main live):** with `main` running, the same two actions open `main`'s terminal
  (labelled "Codev: Architect") and land the reference text there.
- **Option-B check (only if the reviewer switches to B at the gate):** with `main` not live, Open
  Architect Terminal for `main` opens `web`'s terminal labelled **`Codev: Architect (web)`**, and
  Reference Issue lands its text in that same, correctly-labelled terminal — never under a bare-`main`
  caption.

## Acceptance criteria mapping

- *Pressing open-architect for `main` while `main` is not live either opens the alternate under its own
  name/label or refuses with the existing warning* → **refuse** (Part B); Option B available as a
  one-line switch.
- *No terminal is ever cached under `architect:<name>` while hosting a different architect* → Part A
  flows the occupant's own name onward; test 2 + test 3.
- *`injectArchitectText('…','main')` cannot reach a non-`main` architect's terminal* → test 1.
- *Regression test covering the not-live-`main` resolution path* → the new test file (tests 1-3) plus
  the named manual round-trip.
