# agy render-gate capture harness (#1474)

The tooling that produced the real agy fixtures in
`packages/codev/src/agent-farm/__tests__/fixtures/gate/agy-*.txt`, committed so that
re-measuring against a future agy starts from a script rather than from a PR description.
(Same intent as the Spec 1313 capture harness.) Almost nothing here runs in CI — the fixtures
are the committed artifact; this is how to regenerate them. The one exception is
`sanitize.py --selftest`, which `air-1474-sanitize-ordering.test.ts` runs on every build,
because its failure mode is committing someone's username.

## Requirements

- `agy` on PATH and **authenticated** — check with `agy --print "say OK"`. Unauthenticated,
  agy never reaches a composer and every capture is a sign-in screen.
- `node-pty`, resolvable from the repo: run with
  `NODE_PATH=$PWD/packages/codev/node_modules`.

## Capturing

Each state needs a **fresh** cwd, because agy's per-folder trust dialog is both the `trust`
fixture and the first thing every other state must click through.

```bash
export NODE_PATH=$PWD/packages/codev/node_modules
D=$(mktemp -d)
node codev/air-1474-captures/capture-agy.cjs idle /tmp/agy-idle.raw "$D"
```

States: `idle` · `baremarker` (shift+tab ×2 → the no-hint mode whose empty composer is a bare
`>`) · `draft` · `menu` (the slash menu, whose selection cursor is also `> ` in palette-12) ·
`trust` · `quoted` (submits a turn, so the transcript carries agy's `> <message>` echo).

The `agy-torn-echo.busy.txt` fixture is not captured directly — it is the `quoted` capture
**truncated mid-repaint**, which is the frame shape #1361 documents for the adopt seed. Cut it
at a byte offset where the composer row has not yet been repainted and the only `> ` row left
is the palette-4 turn echo.

## Sanitizing (required before committing)

```bash
# set EMAIL in sanitize.py to the account the capture was taken under first
python3 codev/air-1474-captures/sanitize.py /tmp/agy-idle.raw \
  packages/codev/src/agent-farm/__tests__/fixtures/gate/agy-idle.clean.txt
```

It prints a `leaks=[]` line. A non-empty list is not merely a warning: the script refuses,
and **no output file is written at all** — every check runs before anything reaches the
filesystem, so a leaking capture cannot be sitting there for a careless `git add` to pick up.
(It did in the first version, which wrote first and checked second; PR #1491 review.)

Replacements are **same-length**, so the rendered screen is unchanged; no SGR attribute is ever
retouched, because the attributes are the measurement. A cwd shorter than the placeholder comes
back truncated (`/home/agent/p`) — that is expected and is not a leak.

Redaction covers `/tmp/…`, `/home/…` and `/Users/…`, the last so a macOS capture cannot pass
the check while carrying a username. The prefixes the scrubber rewrites and the prefixes the
leak check inspects are the same list; keep them that way if you add one.

Prove the refusal still works after touching any of it:

```bash
python3 codev/air-1474-captures/sanitize.py --selftest
```

## Geometry

Captures are 110×32, and the test replays them at the same size. Changing the geometry
invalidates the committed fixtures — the wrap points, and therefore the row indices the
cursor anchor compares against, move.

## What the fixtures encode

See the provenance table in `packages/codev/src/agent-farm/__tests__/fixtures/gate/README.md`.
The short version: the marker glyph is palette-12 in every mode, the idle hint is palette-8,
typed text is default-fg, the transcript echo of a submitted turn is palette-4, and in every
settled state the cursor rests on the composer row.
