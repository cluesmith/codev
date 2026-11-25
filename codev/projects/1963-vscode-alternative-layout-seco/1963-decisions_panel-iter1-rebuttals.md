# Phase 7 (`decisions_panel`), iteration 1: responses to the reviews

The reviews:
- **Codex:** REQUEST_CHANGES, with one key issue.
- **Claude:** APPROVE, with one key observation and three minor notes.

I checked each claim against the spec and the code, and the rendered claims in the harness. Codex's issue and Claude's observation were both real, and both are fixed. Claude's observation led to a wider contrast check, which found three more theme-mapping errors of mine; those are fixed too.

The Windows run, dispatched after the reviews, failed in the new containment step. That was the test, not the code, and it is fixed. All of this is in `b758f8ffb`.

## Codex

### 1. A refused http(s) image stays a broken image: fixed

**The claim holds.**
- The spec says that an http(s) image the browser refuses shows the existing "Image not loaded" note. Its examples are mixed content inside an https IDE, and a Tower URL answering 401 without the key.
- The shared view gave an `error` handler only to images loaded through the host. A direct remote image that failed was left as a broken `<img>`.
- My rendered check did not catch this: its "refused" image was one Tower refuses, not one the browser fails to load.

**Fixed, in `packages/workspace-views/src/components/DecisionsView.tsx`:**
- Every direct http(s) image gets an `error` listener that replaces it with the note, and its reason reads "The browser could not load this image from its address."
- The listener is registered with the effect's abort signal, so it is removed when the markdown changes or the card goes.
- The error event is queued as a task, so a listener added in the commit that inserted the image cannot miss it.

**Tests:**
- Package: a refused remote image becomes the note, with its alt text, source and reason, while a working remote image beside it is untouched.
- Package: a late error on a detached old image does nothing. This test fails without the abort signal; I checked that by removing the signal.
- Harness: `main-2` now carries a remote image that the browser's route answers with 404. The check requires its note, *Image not loaded Gone board https://example.com/fixture/gone-board.svg*, and that no `<img>` is left for it. The 404 image counts as a remote item image in the scenario 22 audit. The check is in `decisions-03-images.png`.

**Effect on the dashboard:** the view is shared, so a refused remote image in the dashboard now shows the note too, instead of a broken image. That is the behaviour the spec describes. The Phase 6 snapshot comparison is unaffected, because no item in its fixture has a remote image.

## Claude

### Observation 1. Option words faint in Light High Contrast: fixed (they were invisible)

**Confirmed in the screenshot.** In HC Light, `remote` and `local` were near-white on a light background.

**Cause:**
- VS Code injects a default stylesheet into every webview that colours every `code` element with `--vscode-textPreformat-foreground`. That colour is tuned for VS Code's own code background.
- `.decisions-option-word` is a `code` element that paints its own background (`--codev-wv-bg-tertiary`) but set no text colour.
- In the dashboard the browser does not colour `code`, so the word inherited the page colour and read fine.

**Fix, in `packages/workspace-views/src/styles.css`:**
- The rule now sets `color: inherit`, with a comment: it paints its own background, so it owns its text colour.
- In a browser that is a no-op, so the dashboard is unchanged.

**Following "coverage is not contrast":**
- The rendered theme check no longer samples two elements; it measures **every visible text element in the panel (62)** in all four themes.
- Each is measured against its composited background: its own and its ancestors' backgrounds, alpha-blended, with `color-mix()` results parsed.
- It fails below 3:1. It requires 4.5:1 for the item id, Submit and an option word, and 3:1 for the Recommended badge.
- It lists every text under 4.5:1 in the evidence, so nothing between 3 and 4.5 hides behind the floor.

That scan found three more mappings of mine in `vscode-theme.css` that were wrong for text:

| Token | Was | Measured (Light Modern) | Now |
|---|---|---|---|
| `--codev-wv-fg-muted` | `--vscode-disabledForeground`, a disabled-control colour, drawn at half alpha | section labels 2.1:1 | `--vscode-input-placeholderForeground`, VS Code's readable muted grey |
| `--codev-wv-status-error` | `--vscode-errorForeground` (`#F85149` in Light Modern) | the stale-fingerprint refusal 2.8:1 | `--vscode-list-errorForeground`, with the old token as fallback |
| `--codev-wv-status-waiting` | `--vscode-charts-yellow` | "Image not loaded" 2.9:1 | `--vscode-list-warningForeground`, with the old token as fallback |

- VS Code's list colours are the ones it uses for error and warning *text*. High-contrast themes leave them unset, so the fallbacks apply there; those themes measure 5.5:1 and up.
- The error, waiting and bug tints now mix from the same tokens, so a tint always matches its text.
- The theme unit test pins all three mappings, with the reason.

**Final measurements (cycle 7):**

| Theme | Lowest text |
|---|---|
| Dark Modern | 5.5 |
| Dark High Contrast | 6.6 |
| Light High Contrast | 5.5 |
| Light Modern | 4.1 |

The only texts under 4.5:1 are in Light Modern:
- the section labels, at 4.3 (VS Code's own placeholder grey);
- the Recommended badge, at 4.1 (`charts.green`, 10 px uppercase with a border).

I left both as VS Code's colours and recorded them in `verify-decisions.json`.

**Not measured yet:** the Work view uses the implementing orange and the tag colours. It has no VS Code panel until Phase 8, and Phase 8's rendered check should run the same scan.

### Note 2. `word`/`comment` unbounded in the guard: intentional, now documented

Tower caps the ruling body (`MAX_RULE_BODY_BYTES`). It refuses a comment over `MAX_COMMENT_LENGTH` with `comment-too-long` and a reason the panel shows (`servers/decisions/routes.ts`, `splice.ts`). A host-side bound would instead drop a long comment silently, because the guard ignores a message it rejects. The guard's doc comment now says this.

### Note 3. An aborted image leaves a never-settling promise: not a leak, now commented

On abort, the request's resolver is deleted from `pending`. After that, nothing references the inner promise: the abort listener is `once`, and the outer promise has resolved. So the promise and its `then` reaction are garbage-collected, not retained for the panel's lifetime. A comment at the abort handler now says so.

### Note 4. The Windows run must be dispatched and linked: done

- The first run, on `36f7c4acd`, failed the new containment step, 4 of 39 tests. The other jobs passed: CLI tests, probes and install verification. Both causes were in the test:
  - The test canonicalized its temp dir with the JS `realpathSync`, which keeps the runner's 8.3 short name (`RUNNER~1`). The code uses `fs.promises.realpath`, the native call, which gives the long name. The test now uses `realpathSync.native`.
  - The "absolute path outside" case used `/etc/hosts`, which does not exist on Windows, so `not-found` was the right answer. The case now names the fixture's own outside file, which exists on every platform.
- The code under test is unchanged. The run is re-dispatched on `b758f8ffb` and linked in the PR.

## Verification after the changes

- **Harness:** `verify decisions` passed 15/15 on the final build (cycle 7). The evidence in `verification-phase7/` is replaced by that run.
- **apps/vscode:** 127 files, 1686 tests pass (1 Windows-only skip). Type-check is clean for the host and webview configs. Lint shows only the two existing `curly` warnings.
- **packages/workspace-views:** 195 tests pass.
- **apps/web:** 459 tests pass.
