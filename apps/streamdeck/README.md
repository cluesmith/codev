# Codev Stream Deck plugin

A Stream Deck **controller** for Codev. It drives your editor and workspace by
reading Tower's overview API and POSTing **canonical verbs** to the command relay
(`/api/command`); the focused VSCode window maps each verb to a `codev.*` command
and runs it. The plugin holds no Tower state and never edits files directly.

- **Reads** `GET /api/overview` + `GET /api/workspaces` (live-refreshed over SSE).
- **Acts** via `POST /api/command { verb, args, workspace }`.
- **Auth**: reads `~/.agent-farm/local-key` and sends it as the `codev-web-key`
  header (never generates it — Tower owns the key).

The **[Design](#design)** section explains why the plugin is shaped this way; the
[History](#history) section records where it came from.

## Design

The rest of this README is the *what*; this section is the *why*. These decisions
shape everything above.

**A stateless controller, not a second client.** The plugin holds no Tower state
and edits no files. It is a remote: it reads the overview Tower already computes
and POSTs verbs Tower already routes. Everything authoritative lives elsewhere.
Tower owns workspace, builder, and gate state plus the auth key; VSCode owns the
working tree, the review queue, and the composer. The deck only projects that
state onto keys and dials and fires intents back. The payoff is that the device
is disposable: unplug it, restart it, or run two of them, and nothing is lost or
forked, because there was never a second copy of the truth to reconcile. It also
means every surface (deck, VSCode sidebar, web dashboard) reflects one state, so a
change made on any of them shows up on all of them.

**Canonical verbs over a command relay, not direct editor control.** The plugin
never speaks to VSCode directly. It POSTs a small, fixed vocabulary of canonical
verbs to Tower's command relay (`/api/command`), and the focused VSCode window
maps each verb to a `codev.*` command. The decoupling is deliberate: the deck does
not need to know how many editors are open, which one is focused, or how a command
is implemented. Tower routes the verb to the focused window, and each verb is
stamped with the active workspace, so one Tower serving several workspaces sends
each command to the right place. New editor behavior is a new `codev.*` handler,
and the deck's verb set barely moves.

**One shared selection, because the board is a single instrument.** Row 1 selects a
builder, Row 2 acts on it, and the dials review it, with all three pointed at the
same builder. That coherence is the design, not a coincidence: a Row 1 press is
select-and-open in one gesture, and focusing a builder's diff or canvas in VSCode
moves the deck's selection back to it (via the `builder-active` activity hook).
Without one binding selection the three zones would drift and every press would
carry a "which builder?" ambiguity. With it, the board reads as one instrument
aimed at one target.

**Keys commit, dials review, mapped to the hardware.** The interaction model splits
along the SD+'s two physical controls. A key is a discrete, labelled surface, so
keys carry commits: select, approve, run, flush. An encoder is a continuous cursor,
so dials carry review, the one task that is inherently "scan an ordered list and
pick a target." Reviewing a diff walks files, then hunks, then changes; reviewing a
spec walks headings, then blocks. That is a rotate-to-cursor, push-to-act motion,
exactly what a dial is for and what a grid of keys is not. So the dials are
phase-aware review cursors and the keys are the commit buttons: "dials collect,
keys commit."

**The canvas owns composer state; the deck stays mode-neutral.** A dial press does
not decide what happens to the feedback it submits. It relays a mode-neutral verb
(`feedback-file`, `feedback-hunk`, `feedback-selection`); VSCode forwards it to the
builder now or queues it, per the `codev.diffCodelensMode` workspace setting, and
**Send Feedback** flushes a queue. All of that (the queue, the delivery mode, the
composed text) lives in VSCode, the surface that actually renders the artifact. The
deck renders no artifact content and holds no composer state, so it cannot fall out
of sync with what you are reading; the touch strip only names the live mode so a
press is never a surprise. Keeping composer state where the canvas is, and off the
device, is what lets the deck stay a stateless remote.

**Gate approval is never silent, by design.** The deck can surface a gate's approval
modal in VSCode, but it can never approve on the device. Approving a spec, plan, or
PR is a human decision with consequences, so it always lands in front of you in the
editor, where the artifact is, rather than behind a one-touch key on a desk
peripheral. Silent one-touch approval is deliberately out of scope for that reason,
not for want of a spare key.

## Hardware

The plugin targets the **Stream Deck +** (8 LCD keys + 4 dials + touchscreen),
but degrades by model:

| Action group | Works on |
|---|---|
| Keys — Approve Gate, Codev / Builder / Dev-Server Action | **Any** keyed model (Mini, MK.2, XL, +, Neo) |
| Dials — Zoom / PR / Spawn navigators, Diff File / Hunk dials | **Stream Deck + / Studio** (require encoders) |

## Recommended layout (Stream Deck +)

A two-zone board bound by one shared selection: **Row 1 selects, Row 2 acts on
the selection, the dials review it.**

```
┌──────────────────────────────────────────────────────────┐
│  STREAM DECK +                                             │
│                                                            │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │
│  │ Builder│  │ Builder│  │ Builder│  │  Open  │  Row 1:    │
│  │  (1st) │  │  (2nd) │  │  (3rd) │  │  Arch  │  selectors │
│  └────────┘  └────────┘  └────────┘  └────────┘           │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │
│  │Approve │  │  Dev   │  │Send Fb │  │  Bldr  │  Row 2:    │
│  │ Gate   │  │ Server │  │  (N)   │  │  Term  │  palette   │
│  └────────┘  └────────┘  └────────┘  └────────┘           │
│  ┌──────────────────────────────────────────────┐         │
│  │  touch strip: each dial's title + live detail  │         │
│  └──────────────────────────────────────────────┘         │
│      ◉            ◉            ◉            ◉               │
│   Select        Review       Review       Scroll  4 dials  │
│   (Zoom)        Files        Changes               /PR     │
└──────────────────────────────────────────────────────────┘
```

- **Row 1 — fleet selectors.** **Builder Action** keys, each one slot in a **window**
  onto the fleet. The window is **exactly as wide as the number of Builder Action keys
  you place** — put three down (leaving the fourth Row-1 key for something else, like
  Open Architect above) and it is three wide; a Mini or an XL sizes itself the same
  way. The keys self-order by physical position (left to right, top row first), so
  there are no slot numbers to set. With more builders than keys the **Select dial**
  (Zoom Navigator rotate) scrolls the window a page at a time, and the slot holding
  the current selection is accented. Press selects the builder (Row 2 + the dials
  follow) and opens its phase artifact.
- **Row 2 — action palette**, fixed in place, always acting on the **selected**
  builder: **Approve Gate · Dev Server · Send Feedback (N) · Open Builder
  Terminal**. Its sibling **Open Architect Terminal** opens the owning architect
  instead — place it where a slot frees up (e.g. Send Feedback in forward mode).

Nothing is fixed — drag whatever you want onto each slot in the Stream Deck app.
The 5th encoder, **Spawn from Backlog**, can swap onto a dial in place of any of
the four above (e.g. replace PR Nav when you are triaging the backlog).

## Actions

### Keys

- **Builder Action** (Row 1) — a live tile for a builder **slot**, as a **window**
  onto the fleet whose width is the number of these keys you placed (not a fixed
  index): the key's slot is its position among them (reading order, row then column),
  so the Nth key shows the Nth builder on the current page, and the **Select dial**
  scrolls the page so a fleet larger than the window is fully reachable. Because the
  window matches the placed keys, a builder is never selectable while shown on no key.
  It shows the builder's issue + phase, accents the slot holding the selection, and on
  press selects the builder (Row 2 + the dials follow) and opens its phase artifact.
  The default press verb is **Automatic** (the current phase's spec / plan / diff);
  pick a fixed verb in the PI to always run that.
- **Approve Gate** (Row 2) — the **single** approve affordance. Acts on the
  **selected** builder: the face shows its pending gate (e.g. `Plan · Approve`), and
  press surfaces that gate's **approval modal in the focused VSCode window** for you
  to confirm (it never silently approves). Inert when the selection isn't blocked.
- **Dev Server** (Row 2) — runs the dev server for the selected builder's worktree.
- **Send Feedback (N)** (Row 2) — flushes the **selected** builder's queued review
  feedback. The badge `N` mirrors that builder's queued count from the overview:
  in immediate mode `N` stays 0 and the key is inert; in queue mode `N` climbs and
  a press sends the batch (VSCode's Submit Review).
- **Open Builder Terminal** (Row 2) — opens the selected builder's terminal (the
  per-builder complement to Builder Action, which opens the phase artifact; the
  face reads **Builder** over a terminal glyph). To reach a blocked builder off the
  current window, scroll the Select dial — blocked builders show gate-colored
  faces, and the Zoom dial's touchstrip shows the workspace's pending-gate count.
- **Open Architect Terminal** (Row 2) — opens an architect's terminal in VSCode.
  The sibling of Open Builder Terminal. Two
  Property-Inspector modes: **Builder** (default) follows the selected builder and
  opens the architect that spawned it (`spawnedByArchitect`), and is inert
  (dimmed, "None") when nothing is selected or the builder has no recorded owner;
  **Main** always opens the workspace's `main` architect. The key face shows the
  resolved architect's name — the constant title `Architect` over the name — so you
  see who a press would summon before pressing. Recommended home is Row 2 with the
  other builder-scoped keys; the natural donor slot is **Send Feedback while the
  workspace is in forward mode**, where that key is inert by design. Known edges:
  in Main mode when `main` isn't live, VSCode opens the first architect while the
  face still reads `Main` (the mode reflects your configured intent); and a live
  architect registration behind a dead terminal opens a session nobody reads (the
  deck can't detect it). Placement caveat: the Main-mode key is selection-
  independent, so it can live on a **Row 1** key without affecting selection — but
  Row 1's window is a fixed page of four (independent of how many Builder Action
  keys you place), so freeing a Row 1 key leaves three builder slots and hides
  every fourth builder past a three-builder fleet. Recommended for small working
  sets; self-sizing the Row 1 window is tracked separately (#1465).
- **Codev Action** — fires a workspace verb. Choose it in the Property Inspector
  (Open Architect/Builder Terminal, View Diff, Send Message, Spawn Builder,
  Refresh Overview). Defaults to Refresh Overview. (The Open Architect Terminal
  entry here is the generic manual picker — the dedicated **Open Architect
  Terminal** key above is the builder-scoped, face-labelled complement.)

Each dial's touch strip shows a **title + a live value**, refreshed over SSE:
the Zoom Navigator shows the workspace (+ builder/gate counts) or the selected
builder (+ its phase and position); PR / Spawn show the item + `i/N`.

### Dials

- **Zoom Navigator** (zoom dial) — rotate to browse the current altitude
  (workspaces / builders); **tap the touch strip** above the dial to zoom in
  (workspace → its builders, or a builder → open its diff); **press the dial** to
  zoom back out / reset. The workspaces altitude is skipped when only one
  workspace is connected.
- **PR Navigator** — rotate to cycle open PRs; **push** opens the selected PR in
  your browser.
- **Spawn from Backlog** — rotate the backlog; **push** spawns a builder for the
  selected issue (VSCode prompts for the protocol).
- **Review: Files / Headings** — phase-aware coarse review dial. The selected
  builder's phase picks the mode. *Diff phase* (implement / review, or blocked at
  dev-approval / pr): rotate = next / previous file, **push** = submit the current
  file as feedback, **tap** = jump to the first file. *Spec/plan phase* (specify /
  plan, or blocked at spec-approval / plan-approval): rotate = next / previous heading
  in the artifact canvas, **push** = open the composer at the focused block, **tap** =
  jump to the document top. The touch strip names the live mode and, in diff phase,
  the delivery mode (`Files · send` vs `Files · queue`).
- **Review: Changes / Blocks** — phase-aware fine review dial, same mode split.
  *Diff phase*: rotate = next / previous change, **push** = submit the current change
  as feedback, **tap** = jump to the first change. *Spec/plan phase*: rotate = next /
  previous block, **push** = open the composer, **tap** = walk forward to the next
  commented block. The touch strip names the live mode (`Changes · send` /
  `Changes · queue`, or `Blocks`).
- **Scroll** — rotate = scroll the focused editor's viewport (caret stays put);
  **push** = submit the current selection as feedback.

**Dials collect, keys commit.** A diff dial press submits a chunk via a
**mode-neutral** verb (`feedback-file` / `feedback-hunk` / `feedback-selection`);
VSCode routes it forward-now or into the queue per the workspace setting
`codev.diffCodelensMode` (`forward` = immediate, `comment` = queue). The touch strip
names that mode so a press is never a surprise, and **Send Feedback (N)** flushes a
queue. Feedback attaches to the builder whose diff is **focused** (the file in front
of you); Row 2 acts on the **selected** builder — the two are the same builder in
normal use (see *Reviewing specs & plans*).

Verbs are stamped with the active workspace, so a single Tower serving several
workspaces routes each command to the right one.

## Reviewing specs & plans

The plugin gives physical shortcuts into Codev's review flow; the reading,
commenting, and approving still happen in VSCode (the plugin is a controller, it
renders no artifact content on the device):

- **Open the artifact** — a **Builder Action** on **Automatic** opens the current
  phase's artifact (spec / plan / diff) on press; or set a fixed **Open Spec /
  Open Plan / Open Review** verb to always open that one. Pressing it also selects
  the builder, so the **Zoom Navigator** and diff dials land on it.
- **Approve the gate** — **Approve Gate** acts on the selected builder and, on
  press, surfaces that gate's approval modal in VSCode — which carries a *View Plan*
  / *Run Dev* inspect button — for you to review and confirm. It never auto-approves.
- **Send a hunk/file as feedback** — a diff dial press (or the diff-review verbs
  `feedback-file` / `feedback-hunk` / `feedback-selection`) submits a spec/plan/diff
  reference; VSCode forwards it to the builder's terminal now, or queues it, per the
  `codev.diffCodelensMode` setting. A queue is flushed with **Send Feedback**.

**One shared selection binds the board.** Row 1/Row 2 act on the *selected* builder;
the review dials act on the *focused* artifact. Two things keep those the same
builder: a **Row 1 press is select + open in one gesture**, and **focusing a
builder's diff or canvas in VSCode moves the deck selection to it**. So the
selector, the palette, and the dials always point at one builder.

> **Prerequisite for the VSCode→deck focus sync:** the back-sync rides a
> `builder-active` activity hook. Add one to your personal Codev config
> (`~/.codev/config.json`), pointing at the plugin's deep link:
>
> ```json
> { "activityHooks": [ { "on": ["builder-active"],
>   "url": "streamdeck://plugins/message/com.cluesmith.codev/active?workspace={workspace}&builder={builder}" } ] }
> ```
>
> Without it the deck still follows deck-driven selection (Row 1 press / Select
> dial); it just won't follow which window you click into in VSCode.

## Install & develop (sideload)

Requires the Elgato Stream Deck app and the `streamdeck` CLI (a dev dependency
here; or `npm i -g @elgato/cli`). **Build the sdk first** so the
`@cluesmith/codev-sdk` dependency's dist exists before the plugin bundles it.

```bash
# from the monorepo root
pnpm install
pnpm --filter @cluesmith/codev-sdk build           # sdk (tsc) → dist/
pnpm --filter @cluesmith/codev-streamdeck build    # plugin (esbuild) → bin/plugin.js
```

Link the bundle into Stream Deck and start it (the plugin UUID is
`com.cluesmith.codev`):

```bash
streamdeck dev                               # enable developer mode (one-time)
# if a build is already linked (e.g. from another checkout), unlink it first:
streamdeck unlink com.cluesmith.codev
streamdeck link apps/streamdeck/com.cluesmith.codev.sdPlugin   # run from the repo root
streamdeck restart com.cluesmith.codev       # start it (UUID, not the folder)
streamdeck list                              # confirm it points at this checkout
```

Iterate: `pnpm --filter @cluesmith/codev-streamdeck watch` (rebuilds on save; the
sdk must be built once as above), then `streamdeck restart
com.cluesmith.codev` to reload. Logs: `com.cluesmith.codev.sdPlugin/logs/` and
`~/Library/Logs/ElgatoStreamDeck/` (macOS). Uninstall: `streamdeck unlink
com.cluesmith.codev`.

Build a clean Marketplace distributable on demand (bundles, strips dev artifacts —
sourcemap, logs, `.DS_Store` — validates, and packs in one shot; note the `run`,
without it pnpm's own tarball `pack` command shadows the script):

```bash
pnpm --filter @cluesmith/codev-sdk build              # once, if the sdk dist is stale
pnpm --filter @cluesmith/codev-streamdeck run package # → apps/streamdeck/dist/com.cluesmith.codev.streamDeckPlugin
```

## Vendored dependencies

The property inspectors load
[sdpi-components](https://sdpi-components.dev) from a local copy at
`com.cluesmith.codev.sdPlugin/ui/lib/sdpi-components.js` (currently **v4.0.1**),
per Elgato's guidance to bundle the library in distributed plugins. This keeps
action configuration working offline and avoids executing remotely mutable code
in the PI. To bump it, download the release build from
`https://sdpi-components.dev/releases/v4/sdpi-components.js`, replace the file,
and update the version noted here (the version is in the file's license header).

## Follow-focus (optional)

So the deck follows whichever VSCode window / builder you're looking at, add an
activity hook to your **personal** Codev config — `~/.codev/config.json` (applies
to every workspace) or a workspace's `.codev/config.local.json`. **Not** the
committed `.codev/config.json`: it's deliberately ignored for hooks (a committed
hook URL would be a zero-click RCE).

```jsonc
{
  "activityHooks": [
    {
      "on": ["window-focus", "builder-active"],
      "url": "streamdeck://plugins/message/com.cluesmith.codev/active?streamdeck=hidden&workspace={workspace}&builder={builder}",
      "background": true
    }
  ]
}
```

The extension fires this passive deep link on window focus / builder activity (a
focused diff, the builder terminal, or its sidebar row); the plugin re-targets the
matching workspace + builder. Requires the VSCode extension + Tower from Codev with
the activity-hooks support merged.

## Prerequisites at runtime

- **Tower running** (default port 4100). The plugin connects on launch; if Tower
  is down it shows empty/idle and reconnects automatically.
- **VSCode extension running and connected** — it is the editor provider that
  executes the verbs. Commands act on the **focused** window.
- `~/.agent-farm/local-key` present (created by Tower/CLI on first run).

## Status / roadmap

Functional — build/type/unit-verified and validated end-to-end on physical
hardware (Stream Deck +, live Tower; versioned in lockstep with the codev
workspace since 3.3.0). The dial touch strips render title + a live value via
`setFeedback`; a richer SVG/icon render layer (badges, colour by state) is still
out of scope. Silent one-touch gate approval is also deliberately out of scope
(see [Design](#design) for the reason). (Editor scrolling, once out of scope, was
since implemented as the Scroll dial.) The `/api/command` route inherits
Tower's current auth posture; a Tower-auth follow-up is tracked separately.

## History

This plugin was imported into the monorepo under issue #1347 from the
pre-migration repository at commit `77be3d0` (`packages/streamdeck`), as part of
the #1189 SDK consolidation: its `@cluesmith/codev-client` dependency was absorbed
into `@cluesmith/codev-sdk`, and the plugin became the sdk's first
outside-the-original-trio consumer. The design rationale that once lived only in
that repository's planning document now lives in-tree, under [Design](#design)
(issue #1390); the pre-migration repository, which holds the earlier development
history, is slated for retirement after the sdk's first npm publish.
