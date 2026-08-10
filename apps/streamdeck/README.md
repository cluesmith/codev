# Codev Stream Deck plugin

A Stream Deck **controller** for Codev. It drives your editor and workspace by
reading Tower's overview API and POSTing **canonical verbs** to the command relay
(`/api/command`); the focused VSCode window maps each verb to a `codev.*` command
and runs it. The plugin holds no Tower state and never edits files directly.

- **Reads** `GET /api/overview` + `GET /api/workspaces` (live-refreshed over SSE).
- **Acts** via `POST /api/command { verb, args, workspace }`.
- **Auth**: reads `~/.agent-farm/local-key` and sends it as the `codev-web-key`
  header (never generates it — Tower owns the key).

Architecture and design decisions live in the pre-migration repo's `PLAN.md`
(see [History](#history)).

## Hardware

The plugin targets the **Stream Deck +** (8 LCD keys + 4 dials + touchscreen),
but degrades by model:

| Action group | Works on |
|---|---|
| Keys — Approve Gate, Codev / Builder / Dev-Server Action, Fleet Slot | **Any** keyed model (Mini, MK.2, XL, +, Neo) |
| Dials — Zoom / PR / Spawn navigators, Diff File / Hunk dials | **Stream Deck + / Studio** (require encoders) |

## Recommended layout (Stream Deck +)

```
┌──────────────────────────────────────────────────────────┐
│  STREAM DECK +                                             │
│                                                            │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │
│  │ Approve│  │ Builder│  │  Dev   │  │ Codev  │   keys 1–4 │
│  │ Gate ⓷ │  │ Action │  │ Server │  │ Action │           │
│  └────────┘  └────────┘  └────────┘  └────────┘           │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐           │
│  │ Fleet  │  │ Fleet  │  │ Fleet  │  │ Fleet  │   keys 5–8 │
│  │ Slot   │  │ Slot   │  │ Slot   │  │ Slot   │  (pin 4)   │
│  └────────┘  └────────┘  └────────┘  └────────┘           │
│  ┌──────────────────────────────────────────────┐         │
│  │  touch strip: each dial's title + live detail  │         │
│  └──────────────────────────────────────────────┘         │
│      ◉            ◉            ◉            ◉               │
│    Zoom         Diff         Diff          PR     4 dials  │
│    Nav          File         Hunk          Nav             │
└──────────────────────────────────────────────────────────┘
```

Nothing is fixed — drag whatever you want onto each slot in the Stream Deck app.
The 5th encoder, **Spawn from Backlog**, can swap onto a dial in place of any of
the four above (e.g. replace PR Nav when you are triaging the backlog).

## Actions

### Keys

- **Approve Gate** — badge shows the count of pending gates. Press surfaces the
  next gate's **approval modal in the focused VSCode window** for you to confirm
  (it never silently approves — the human stays in the loop).
- **Codev Action** — fires a workspace verb. Choose it in the Property Inspector
  (Open Architect/Builder Terminal, View Diff, Send Message, Spawn Builder,
  Refresh Overview). Defaults to Refresh Overview.
- **Builder Action** — pins to a builder **slot** (the Nth builder) and fires a
  verb for it. Slot + verb are set in the PI; defaults to View Diff.
- **Dev Server** — runs the dev server for the builder the Zoom Navigator is on.
- **Fleet Slot** — pin one builder per key (set its slot + verb in the PI);
  the key shows that builder's status and fires its verb on press.

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
- **Diff File Navigator** — rotate = next / previous file in a diff review;
  **push** = forward the current file to the builder; **tap the touch strip** =
  jump to the first file.
- **Diff Hunk Navigator** — rotate = next / previous change; **push** = forward
  the current change to the builder; **tap the touch strip** = jump to the first
  change.
- **Scroll** — rotate = scroll the focused editor's viewport (caret stays put);
  **push** = forward the current selection to the builder.

Verbs are stamped with the active workspace, so a single Tower serving several
workspaces routes each command to the right one.

## Reviewing specs & plans

The plugin gives physical shortcuts into Codev's review flow; the reading,
commenting, and approving still happen in VSCode (the plugin is a controller, it
renders no artifact content on the device):

- **Open the artifact** — set a **Builder Action** (or **Fleet Slot**) verb to
  **Open Spec / Open Plan / Open Review**; pressing it opens that builder's
  artifact in VSCode. Pair it with the **Zoom Navigator** to land on the builder
  first.
- **Approve the gate** — **Approve Gate** badges pending gates (including
  `plan-approval`) and, on press, surfaces that gate's approval modal in VSCode —
  which carries a *View Plan* / *Run Dev* inspect button — for you to review and
  confirm. It never auto-approves.
- **Forward a hunk/file for changes** — the diff-review verbs (`view-diff`,
  `forward-file`, `forward-hunk`, `add-comment`) drive the same diff-injection the
  VSCode sidebar uses, so a key can push a spec/plan/diff reference straight to the
  builder's terminal.

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
out of scope. Also deliberately out of scope (see the pre-migration `PLAN.md`):
silent one-touch gate approval. (Editor scrolling, originally out of scope there,
was since implemented as the Scroll dial.) The `/api/command` route inherits
Tower's current auth posture; a Tower-auth follow-up is tracked separately.

## History

This plugin was imported into the monorepo (issue #1347) from
[`cluesmith/codev-integrations`](https://github.com/cluesmith/codev-integrations)
at commit `77be3d0` (`packages/streamdeck`), as part of the #1189 SDK
consolidation: its `@cluesmith/codev-client` dependency was absorbed into
`@cluesmith/codev-sdk`, and the plugin became the sdk's first
outside-the-original-trio consumer. Pre-migration history (including the
original `PLAN.md` design document) lives in that repo.
