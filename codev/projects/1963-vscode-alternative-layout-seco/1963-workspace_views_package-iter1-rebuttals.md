# Phase 6 (`workspace_views_package`), iteration 1: responses to the reviews

Codex: REQUEST_CHANGES, two key issues. Claude: APPROVE, five non-blocking notes. I checked each
claim against the code, and Codex's first one against VS Code's own webview script, before acting.
Both of Codex's issues and Claude's first note were real; all are fixed. The rest are fixed where
cheap, or noted.

## Codex

### 1. Work's issue and PR links bypass the host: fixed

The claim holds, and it is worse than "a link opens in a tab". I read VS Code's webview script
(`out/vs/workbench/contrib/webview/browser/pre/index.html`, `handleInnerClick`). It listens for
`click` on the webview's window, in the bubble phase, and does **not** check `defaultPrevented`.
For any anchor with an `href`, it posts `did-click-link`, and VS Code opens the URL with its own
opener. That opener accepts more than http(s), which is exactly what the spec's risk row
("a webview-supplied … URL is used to open … a non-web scheme") and its success criterion (the
host opens externally only `http:`/`https:`) rule out. Work's links carry forge data (issue and PR
URLs), so in a webview they would have bypassed the host's allowlist entirely.

The same script also meant Decisions had a latent double open. Its link handler already called
`preventDefault` and `host.openExternal`, but the click still bubbled to VS Code's listener, which
would have opened the link a second time.

**Fixed:**
- `WorkViewHost.openExternal?(url)` is new. When the host provides it, each of Work's four external
  links (the Needs Attention row, the Backlog row, the Recently Closed row and its PR link) hands
  the URL to the host. The click's default is prevented and propagation is stopped, so nothing
  outside the view sees it. The helper is `lib/links.ts` (`hostLinkClick`).
- The link keeps its `href`, `target` and `rel`, so its DOM is identical with or without the action.
- Without `openExternal`, the links stay plain links the page opens itself. That is the
  dashboard's behaviour (including Cmd-click and middle-click), and the dashboard does not pass
  it. `host.ts` says a webview host must provide it.
- Decisions' link clicks now stop propagation too.
- `host.ts` gains a *Links* note: a host-owned link is handled entirely by the view, and the host
  decides which external opens it allows (a webview host: http(s) only, enforced host-side in
  Phase 7, as the plan has it).
- I checked the dashboard for anything the stopped propagation could starve. There are no
  `window`/`document` click listeners in `apps/web`, the package or artifact-canvas. The React
  click handlers in `App.tsx` and `SplitPane.tsx` are on buttons, not on ancestors of the views.

**Tests:** `WorkView.test.tsx`:
- each of the four links, with `openExternal`, calls the host with its URL, is prevented, and never
  reaches a `window` click listener;
- without it, the three row links are plain (not prevented, they reach the window), and the PR link
  keeps its existing `stopPropagation`.

`DecisionsView.host.test.tsx`: a link click goes to the host and never reaches the window.
Removing either `stopPropagation` fails these tests (checked by mutation).

### 2. `color: white` left untokenised: fixed

The claim holds, twice: `.work-btn` and `.decisions-submit-btn`. My earlier colour scan matched
hex and `rgb()`, not keyword colours. Both now use `var(--codev-wv-on-accent, white)`, and the token
is in the table. Its default is white, and the dashboard does not map it, so the dashboard is
unchanged.

**New test:** `styles-tokens.test.ts` scans every declaration in `styles.css`. It fails on any hex,
colour function or named colour outside a `--codev-wv-*` token, on a `font-family` not set through
a token, and on the stylesheet defining a token itself. It found the second `white` before I did.

## Claude

### 1. `host.read` detached, and polling identity-sensitive: fixed

Both halves hold:
- `useDecisions(host.read, …)` lost `this` for a class-based host.
- `load` depended on `read`, so a new `read` on every render (an inline arrow in a webview entry)
  would have restarted the interval and re-read on every keystroke in the comment box. No test
  covered either.

**Fixed:**
- `DecisionsView` passes `() => host.read()`, so a class instance keeps its `this`.
- The hook keeps the latest `read` in a ref, updated in an effect. `load` no longer depends on
  `read`'s identity, so a new function neither restarts polling nor reads at once, and the next
  poll calls the latest one.

**Tests:**
- `useDecisions.test.ts`: five re-renders with new arrows mid-interval cause no read, the interval
  keeps its schedule, and the next poll calls the latest arrow.
- `DecisionsView.host.test.tsx` (the real hook, a class-based host): it reads through `this`, and
  typing five characters into the comment box causes no further read.

Reverting the ref fails three of these (checked by mutation).

`host.ts` now says which host must be stable. The Decisions view keys effects on its host (a new
host object reloads its images), so pass the same one on every render. The Work view keys nothing
on its host, which carries the overview and so is a new object whenever that changes.

### 2. `handleOpenArtifact` has no catch: fixed in place

It matched the pre-move code (`BacklogList`'s inline handler had no catch either), so it was parity,
not a regression. It is a small adjacent bug, so I fixed it here. The handler now catches and
logs `Failed to open file:`, like its sibling `handleNewShell` and `App.tsx`'s own file opener.
Nothing visible changes.

### 3. Cosmetic: fixed

- `one-copy.test.ts` normalises paths to `/` separators.
- `WorkView.test.tsx` checks the class list (`['work-view']`), not a `className` with a trailing
  space.

### 4. Styles imported from `main.tsx`, not `index.css`: no change

Agreed, and that was deliberate. It matches the artifact-canvas `default-theme.css` precedent, and
the import order keeps the dashboard's own rules winning ties.

### 5. `image(path, signal)` has a required signal: noted for Phase 7

The plan wrote `signal?`. The view always passes one, so required is the stricter contract. The
Phase 7 adapter takes it as required.

## Re-verification

- The package's 193 tests pass, and its type-check is clean.
- apps/web: all 37 test files pass under Node 26 with `--no-experimental-webstorage` (see the thread
  note), and `check-types` is clean.
- The rendered dashboard check was re-run on this iteration's build, against the same baseline.
  The results replace `verification-phase6/after/`.
