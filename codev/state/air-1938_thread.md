# air-1938 — Decisions tab: images from the workspace inline

## Implement

- Server: `GET /workspace/<enc>/api/decisions/image?path=` in `servers/decisions/routes.ts`
  (`handleDecisionsImage`). It reuses `locate()`, so no decisions file means no images. Relative
  paths resolve against the directory of the *configured* decisions path, not its realpath.
  Containment is checked twice: lexically, before anything touches the disk (so there is no
  existence probe outside the workspace), and again on the realpath. The extension allowlist
  is checked on the requested path *and* on its realpath target, so an `x.png` symlink to
  `.env` is refused. `stat` runs before `readFile`, so a FIFO named `*.png` is never opened.
  Two new refusal codes: `not-an-image` (415) and `image-too-large` (413). A sandbox CSP sits
  on top of `nosniff`.
- Client: the issue said "the client fetches, the browser does not", but `MarkdownView` renders
  through innerHTML, and the browser starts a native `<img>` load as soon as the fragment is
  parsed, before any layout effect can run. That load 401s against Tower's key gate (or hits
  the SPA fallback). So `DecisionsMarkdown` now calls `renderMarkdown` directly, parks every
  non-http(s) `src` in `data-decisions-src` inside an inert `DOMParser` document, and only then
  injects the HTML. The shared renderer is unchanged.
- Surprise: opening an SVG's blob URL in a new tab would run the SVG's scripts as the
  dashboard's origin (blob URLs inherit the creator's origin), and the dashboard stores the Tower
  key in localStorage. So the full-size click opens a tiny HTML page we write, holding only an
  `<img>` of the blob. That keeps the issue's "SVG only through <img>" rule true for the click
  too.
- Parser: no change. A fixture test confirms image lines in the body, and on the line directly
  above `**Your word:**`, leave ids, options and writability alone, and that a ruling splices
  in correctly.
- `localStorage` is undefined under this Node in jsdom tests, so the view test supplies the key
  as `window.__CODEV_TOWER_KEY__`, the way Tower injects it.
- Bug found by the Playwright case: React 19 re-sets `dangerouslySetInnerHTML` whenever the prop
  *object* changes identity, and `{ __html: html }` is a new object on every render. So any
  re-render of a card (a poll that brings a new document, a ruling, a draft keystroke) wiped the
  loaded `src`, and the effect, keyed on the unchanged string, never re-ran. The fix is to
  memoize the `{ __html }` object. This was already true of the shipped `MarkdownView` and the
  link rule: after any re-render a relative link got its `href` back. I verified that with a
  throwaway test against `MarkdownView` and fixed it in place, since `DecisionsMarkdown` no
  longer goes through `MarkdownView`. Lesson added to `lessons-learned.md` (UI/UX).
- Local env: under Node 26, 93 terminal/keyboard/toolbar tests in apps/web fail on
  `localStorage.getItem` of undefined, because Node's built-in web storage shadows jsdom's. With
  `NODE_OPTIONS=--no-experimental-webstorage` the whole web suite passes (598). This predates
  and is unrelated to the change.
