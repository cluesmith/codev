# @cluesmith/codev-artifact-canvas

A host-agnostic React library for rendering and reviewing Codev markdown artifacts (specs, plans,
reviews) across surfaces — the VSCode extension, the Tower dashboard, and future mobile. The
package owns **rendering, the comment-intent overlay, and minimal marker display**; the host owns
**I/O, serialization, theming source, and comment write-back** through three small adapter
interfaces.

This package is the foundation for the cross-surface review work (#945). It ships no host
integration of its own — hosts wire it up by implementing the adapters below.

## Install

This package is **not independently published to npm in v1** (per spec-945). It is consumed inside
this monorepo via the workspace protocol and **bundled by each host** — version-aligned with the
other `@cluesmith/*` packages but absent from the `pnpm publish` step. Add it as a workspace
dependency of a host package:

```jsonc
// packages/<your-host>/package.json
{
  "dependencies": {
    "@cluesmith/codev-artifact-canvas": "workspace:*"
  }
}
```

`react` / `react-dom` are peer deps (`^18 || ^19`), supplied by the host.

```tsx
import { ArtifactCanvas } from '@cluesmith/codev-artifact-canvas';
import '@cluesmith/codev-artifact-canvas/default-theme.css';
```

## The component

`<ArtifactCanvas>` reads a document via the `FileAdapter`, lists markers via the `MarkerAdapter`,
renders sanitized markdown, and emits a **comment intent** (`onAddComment(line)`) when the user
clicks the hover `+` or presses Enter/Space on a focused block. It never writes markers itself —
the host performs the input and calls its own `MarkerAdapter.add` (spec D6).

### `ArtifactCanvasProps`

| Prop | Type | Notes |
|------|------|-------|
| `uri` | `string` | Host-opaque document id. The package never treats it as a filesystem path. |
| `fileAdapter` | `FileAdapter` | Reads + watches the document. |
| `markerAdapter` | `MarkerAdapter` | Lists markers (the component calls only `list`). |
| `themeAdapter` | `ThemeAdapter` | Accepted but **not on the v1 render path** (see Theming). |
| `onAddComment` | `(line: number) => void` | Comment intent; `line` is **0-based** (spec D5). |
| `onError?` | `(err: unknown) => void` | Optional sink for genuine adapter failures. The component never throws out of an event handler. |
| `refreshKey?` | `number \| string` | For hosts **without** a watcher: pass a new value whenever the underlying data changes to force a re-read + re-list. Hosts with a watcher omit it. |
| `initialReadingMode?` | `string` | Seed for the reading mode (spec 1380). Typed `string` because it round-trips through host persistence and arrives untrusted; anything other than `'horizontal'` is coerced to `'vertical'`. |
| `onReadingModeChange?` | `(mode: ReadingMode) => void` | Toggle intent: the host persists it per-user (VS Code `globalState`, browser `localStorage`, …) or ignores it — the canvas works without persistence, defaulting to vertical each mount. |

### Reading modes (spec 1380)

Vertical single-column flow is the default and is behaviorally unchanged for hosts that never
touch the mode props. The canvas-rendered toggle (top-right) switches to a **horizontal
multi-column reading mode**: content flows top-to-bottom in fixed-height columns of readable
measure, continuing rightward newspaper-style inside a horizontally scrolling container.
Highlights: protected block types (code, tables, images, comment cards, the open composer)
never split across a column boundary; over-tall code/tables/cards get an inner vertical
scroll; the vertical wheel is remapped to horizontal travel (yielding to inner scrollers,
never touching trackpad horizontal gestures or pinch); PageUp/PageDown step whole columns; a
"Column *k* of *n*" readout replaces the scrollbar's positional feedback; the marker minimap
is suppressed in this mode.

**Host requirements**: give the canvas a bounded height (a `height: 100%` chain from the
viewport to the canvas container — see the two reference hosts). In an embed with no height
context the canvas self-bounds to the visual viewport height. Persistence is host-owned via
the two props above. The `afx open` browser annotator inherits this mode when it adopts the
canvas (#1386).

## The three adapters

Interfaces only — implementations live in the host.

### `FileAdapter` — content + change notification

```ts
interface FileAdapter {
  read(uri: string): Promise<string>;
  watch(uri: string, onChange: (content: string) => void): Disposable;
}
```

`read` is async; `watch` is **synchronous** — it registers a subscription and returns a
`Disposable` immediately, while change notifications arrive later via `onChange`. The host owns any
debouncing/coalescing. `dispose()` must be idempotent (spec D2).

### `MarkerAdapter` — review markers (serialization-agnostic)

```ts
interface MarkerAdapter {
  list(uri: string): Promise<ReviewMarker[]>;
  add(uri: string, line: number, text: string, author: string): Promise<void>;
}
```

The component calls only `list`. `add` is **host-invoked** (spec D6). How a marker is serialized is
the adapter's choice — e.g. the VSCode host writes a positional `<!-- REVIEW(@author): text -->`
into the file text (text is the source of truth, spec D3). A `ReviewMarker` is:

```ts
interface ReviewMarker {
  author: string;
  line: number;   // 0-based, matches the renderer's data-line (spec D5)
  text: string;
  raw: string;    // original on-disk marker text, for lossless round-tripping
  lineRange?: { start: number; end: number }; // reserved (regions); unused in v1
}
```

A marker whose `line` is out of range (≥ the document's line count — e.g. a stale marker after the
document was truncated) is **dropped** (not rendered, not mis-anchored) and reported once via
`console.warn`. `onError?` is reserved for genuine adapter failures, not data hygiene.

### `ThemeAdapter` — JS-side theme access (off the v1 render path)

```ts
interface ThemeAdapter {
  resolve(token: string): string;          // e.g. resolve("--codev-canvas-foreground")
  onChange(handler: () => void): Disposable;
}
```

v1 theming is **entirely CSS-custom-property driven** (see below), so the v1 component does **not**
call `resolve()` or subscribe to `onChange`. This adapter exists for JS-side consumers that must
read an exact value — chiefly the future `<canvas>` minimap (#863), which needs a hex color to
paint pixels.

## Theming (CSS custom properties — spec D4, Model A)

Import the default stylesheet and override any subset of the `--codev-canvas-*` tokens on the
`.codev-artifact-canvas` container. There is no JS theming on the v1 render path.

**Color tokens** (spec 945 D4):

| Token | Default |
|-------|---------|
| `--codev-canvas-foreground` | `#1f2328` |
| `--codev-canvas-background` | `#ffffff` |
| `--codev-canvas-accent` | `#0969da` |
| `--codev-canvas-border` | `#d0d7de` |
| `--codev-canvas-muted` | `#656d76` |
| `--codev-canvas-code-background` | `#f6f8fa` |
| `--codev-canvas-code-foreground` | `#1f2328` |
| `--codev-canvas-link` | `#0969da` |
| `--codev-canvas-comment-marker` | `#bf8700` |

**Column tokens** (spec 1380, horizontal mode): `--codev-canvas-column-width` (`25em`, a
preferred minimum — rendered columns stretch to share leftover width) and
`--codev-canvas-column-gap` (`3em`). These are `em`-relative (#1070) so the minimum measure
scales with the prose font size — `25em`/`3em` equal the former `400px`/`48px` at the 16px
baseline. Overriding them is the supported way to retune the mode;
there is no settings UI. The canvas also publishes `--codev-canvas-column-height` (the
JS-observed column height, in px, on the canvas root) for derived rules; it is an output, not
a knob. Note `--codev-canvas-prose-max-width` is **inert in horizontal mode** — it caps the
very element that becomes the multi-column container, so the column-width token governs
measure there instead.

**Typography tokens** (#1053). Defaults mirror [github-markdown-css](https://github.com/sindresorhus/github-markdown-css)
v5.8.1 so prose reads cleanly instead of inheriting the host's code-tuned font. Theme-invariant
(dark mode is covered by the color tokens above):

| Token | Default | Controls |
|-------|---------|----------|
| `--codev-canvas-font-size` | `16px` | prose body size |
| `--codev-canvas-font-family` | system sans stack | prose body font |
| `--codev-canvas-line-height` | `1.5` | prose line-height |
| `--codev-canvas-paragraph-spacing` | `16px` | gap below paragraphs / lists / blockquotes / tables / `pre` |
| `--codev-canvas-prose-max-width` | `none` | optional readable-measure cap (e.g. `72ch`); off by default |
| `--codev-canvas-h1-size` … `--codev-canvas-h6-size` | `2em` / `1.5em` / `1.25em` / `1em` / `0.875em` / `0.85em` | per-level heading sizes |
| `--codev-canvas-code-font-family` | system monospace stack | `pre` / inline `code` font |
| `--codev-canvas-code-font-size` | `0.85em` | `pre` / inline `code` size |

```css
/* Bind the canvas to the host's theme — e.g. a VSCode webview */
.codev-artifact-canvas {
  --codev-canvas-foreground: var(--vscode-foreground);
  --codev-canvas-background: var(--vscode-editor-background);
  --codev-canvas-accent: var(--vscode-focusBorder);
  /* Code blocks track the editor font; prose keeps the readable sans stack. */
  --codev-canvas-code-font-family: var(--vscode-editor-font-family);
  /* Pair inline-code fg+bg from the same theme group so they always contrast. */
  --codev-canvas-code-background: var(--vscode-textPreformat-background);
  --codev-canvas-code-foreground: var(--vscode-textPreformat-foreground);
}
```

## Host walkthrough

```tsx
import { ArtifactCanvas } from '@cluesmith/codev-artifact-canvas';
import '@cluesmith/codev-artifact-canvas/default-theme.css';

// 1. Implement the adapters against your host's I/O + serialization.
const fileAdapter: FileAdapter = {
  read: (uri) => myFs.readFile(uri),
  watch: (uri, onChange) => myFs.watch(uri, () => myFs.readFile(uri).then(onChange)),
};
const markerAdapter: MarkerAdapter = {
  list: (uri) => myFs.readFile(uri).then(parseReviewComments),
  add: (uri, line, text, author) => myFs.writeReviewComment(uri, line, text, author),
};
const themeAdapter: ThemeAdapter = {
  resolve: (token) => getComputedStyle(root).getPropertyValue(token),
  onChange: (h) => myTheme.onDidChange(h),
};

// 2. Render. onAddComment is where YOU collect input + write back.
<ArtifactCanvas
  uri="spec://42"
  fileAdapter={fileAdapter}
  markerAdapter={markerAdapter}
  themeAdapter={themeAdapter}
  onAddComment={async (line) => {
    const text = await promptUserForComment();
    if (text) await markerAdapter.add('spec://42', line, text, currentUser);
  }}
/>
```

When `add` writes into the file, your `watch` fires, the component re-lists, and the new marker
renders — the round-trip goes *through text*, not an in-memory side channel.

### Try it locally

`pnpm dev:example` launches a Vite page (`examples/`) wired to in-memory stub adapters and a sample
artifact, so you can exercise hover/click/keyboard by hand. The automated equivalent — the
authoritative contract proof — is `src/__tests__/end-to-end.test.tsx`.

## Why `tsup`?

The package builds with [`tsup`](https://tsup.egoist.dev/) (esbuild + `rollup-plugin-dts`) to emit
**dual CJS + ESM + a single `.d.ts`** from one config. Hosts span module systems — the VSCode
extension bundle, the Vite/ESM dashboard, and Node tooling — so dual output is a requirement, not a
convenience. `tsup` produces it with far less config than a hand-rolled Rollup/tsc matrix. **Do not
"normalize" the build to plain `tsc`**: `tsc` alone won't emit the CJS variant the extension host
consumes, and the dual-format `exports` map in `package.json` depends on both being present.

## Scope

v1 deliberately stops at: safe rendering, the comment-intent overlay, and minimal line-level marker
display. Polished inline marker bubbles and the `<canvas>` minimap are #863; host integration is
tracked separately (#859 and follow-ups). The adapter interfaces are the locked contract those
issues build on.
