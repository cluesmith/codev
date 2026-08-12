# PIR Plan: Clickable `#N` / `PR #N` terminal references (VS Code)

## Understanding

Terminal output in the VS Code extension constantly cites issues and PRs by number
(`#915`, `PR #1402`). Cmd+click on those spans falls through to VS Code's workspace word
search, which matches nothing. The issue (decided design, 2026-08-12) asks for a
`registerTerminalLinkProvider` that claims `#\d+` and `PR #\d+` spans and, on click:

- **`PR #N`** → open the PR's forge page in the browser (there is no in-editor PR preview — #1179).
- **bare `#N`** → issue-first: open the in-editor issue viewer (`viewBacklogIssue`, the #1096
  preview) unless the number is actually a PR, in which case fall through to the PR browser-open.
  One click, no disambiguation prompt.
- **Setting** `codev.terminalLinks.issueTarget: editor | browser` (default `editor`) lets users
  send genuine issues to the browser too. (PRs ignore it — browser is their only destination.)
- Unresolvable number → warning toast matching `openIssueById`'s failure grammar.

The design is settled; this plan is the **how**. Two empirical findings drove the design below.

### Finding 1 — the issue-vs-PR discriminator (architect concern #3, verified)

The issue text assumed the issue fetch would *fail* on a PR number. **It does not.** GitHub's
`gh issue view` (what the `issue-view` forge concept runs —
`packages/codev/scripts/forge/github/issue-view.sh:5`) resolves a **PR** number successfully:

```
$ gh issue view 1405 --json state,url   # 1405 is a merged PR
{"state":"MERGED","url":"https://github.com/cluesmith/codev/pull/1405"}   # exit 0
$ gh issue view 1412 --json state,url    # 1412 is a genuine issue
{"state":"OPEN","url":"https://github.com/cluesmith/codev/issues/1412"}   # exit 0
```

So `getIssue(N)` returns a populated object for **both** issues and PRs. The clean, deterministic
discriminator is the **`url` path segment**: a PR's url is `.../pull/N`, an issue's is
`.../issues/N`. `IssueView.url` exists (optional string — `packages/types/src/api.ts:403`) and is
populated for GitHub. This *is* the faithful reading of the decided design's "if the number
resolves as a PR instead" — "resolves as a PR" == the resolved url is a `/pull/` url.

### Finding 2 — the VS Code API shape (architect concern #1, verified against the pinned engine)

Against the bundled `@types/vscode` (`~1.105.0`, matching `engines.vscode ^1.105.0`):

- `TerminalLinkProvider<T>` has `provideTerminalLinks(context, token)` and `handleTerminalLink(link)`.
- `TerminalLinkContext.line` is documented as **"the text from the unwrapped line"**
  (`index.d.ts:8099`). So VS Code hands the provider one **logical, unwrapped** line — a reference
  split across a visual wrap is *not* a problem (architect concern #4: no real wrap limitation to
  document; refs are only ever missed if a *logical* line break splits them, which terminal output
  does not do to a `#1234` token). Multiple refs per line are handled by scanning the line.
- The d.ts warns: *"do not share global objects (eg. `RegExp`) that could have problems when
  asynchronous usage may overlap."* We construct the regex **inside** `provideTerminalLinks` (or use
  `String.prototype.matchAll`) rather than the module-level shared-`lastIndex` pattern the sibling
  `BuilderTerminalLinkProvider` uses — safer and idiomatic for the documented reentrancy.

This is an established local pattern: `terminal-link-provider.ts` already hosts two providers
(`BuilderTerminalLinkProvider`, `ReconnectTerminalLinkProvider`) registered in `extension.ts`.

## Proposed Change

### Reuse discipline (the core review axis)

No new fetch code. The only forge paths touched are the three sanctioned reuse targets:

- `openPRInBrowser(cm, N)` — `commands/open-pr-by-id.ts` (getPR → openExternal)
- `openIssueInBrowser(cm, N)` — `commands/open-issue-by-id.ts` (getIssue → openExternal, preview-fallback)
- `viewBacklogIssue(cm, N)` — `commands/view-issue.ts` (getIssue → in-editor preview)

The discriminator itself calls `client.getIssue(N)` — the **same SDK method** those helpers use,
not new fetch code — purely to read the resolved `url` and branch. Every actual *open* funnels
through one of the three helpers, so there is exactly one code path per destination.

### Resolution logic — new file `apps/vscode/src/commands/open-terminal-ref.ts`

Mirrors `open-issue-by-id.ts` / `open-pr-by-id.ts` (the named template). Exports one function:

```ts
export async function openTerminalRef(
  cm: ConnectionManager,
  ref: { number: string; isPR: boolean },
): Promise<void>
```

- **`ref.isPR`** (explicit `PR #N`): `await openPRInBrowser(cm, ref.number)`. No discriminator
  fetch needed — the prefix already told us it's a PR.
- **bare `#N`**: connection guard (client + workspacePath + `getState() === 'connected'`, same guard
  as the helpers; error toast if not connected), then `const issue = await client.getIssue(number)`:
  - `!issue` → `showWarningMessage("Codev: Could not open #N (not found, or forge unavailable).")`
    (matches `openIssueInBrowser`'s grammar).
  - `issue.url` matches `/\/pull\/\d/` → it is actually a PR → `await openPRInBrowser(cm, number)`
    (funnel through the single PR-open path — consistent with the explicit `PR #N` branch; the extra
    `getPR` round-trip on a single deliberate click is negligible and keeps one owner of PR-opening).
  - otherwise (genuine issue, incl. url absent on a non-GitHub forge → treated as issue) → read the
    setting `getConfiguration('codev').get<string>('terminalLinks.issueTarget', 'editor')` **at click
    time** (picks up live changes):
    - `editor` → `await viewBacklogIssue(cm, number)`
    - `browser` → `await openIssueInBrowser(cm, number)`

### Provider — extend existing `apps/vscode/src/terminal-link-provider.ts`

Add a third provider co-located with the other two (stronger house convention than a near-duplicate
new file; the file is literally named for this):

```ts
interface IssueRefLink extends vscode.TerminalLink { number: string; isPR: boolean; }

export class IssueRefTerminalLinkProvider implements vscode.TerminalLinkProvider<IssueRefLink> {
  constructor(private connectionManager: ConnectionManager) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): IssueRefLink[] {
    const re = /(?<pr>\bPR\s+)?#(?<num>\d+)/gi;   // fresh per call — no shared lastIndex
    const links: IssueRefLink[] = [];
    for (const m of context.line.matchAll(re)) {
      const isPR = Boolean(m.groups?.pr);
      links.push({
        startIndex: m.index,
        length: m[0].length,                       // claims the whole "PR #N" span → kills fallback search
        tooltip: isPR ? `Open PR #${m.groups!.num} in browser` : `Open issue #${m.groups!.num}`,
        number: m.groups!.num,
        isPR,
      });
    }
    return links;
  }

  handleTerminalLink(link: IssueRefLink): Promise<void> {
    return Promise.resolve(openTerminalRef(this.connectionManager, { number: link.number, isPR: link.isPR }));
  }
}
```

Regex notes: the optional greedy `(?<pr>\bPR\s+)?` prefers the `PR #N` form when present, so in
`PR #1402` the whole span is claimed once and the inner `#1402` is **not** separately matched
(matchAll advances past the consumed span). `\b` before `PR` avoids `SUPR #12`. `#\d+` never matches
`#fff` (hex color) or `# 1` (heading, space before digit). Case-insensitive so `Pr`/`pr` also match.

### Registration — `apps/vscode/src/extension.ts` (~line 1450, beside the existing two providers registered at 1440/1447)

```ts
context.subscriptions.push(
  vscode.window.registerTerminalLinkProvider(
    new IssueRefTerminalLinkProvider(connectionManager),
  ),
);
```

`connectionManager` is already in scope at that point (used a few lines above).

### Setting — `apps/vscode/package.json` `contributes.configuration.properties`

```json
"codev.terminalLinks.issueTarget": {
  "type": "string",
  "enum": ["editor", "browser"],
  "enumDescriptions": [
    "Open bare #N issue references in the in-editor issue viewer.",
    "Open bare #N issue references in your browser."
  ],
  "default": "editor",
  "markdownDescription": "Where Cmd+clicking a bare `#N` issue reference in a terminal opens it. `PR #N` references always open in the browser (there is no in-editor PR preview)."
}
```

## Files to Change

- `apps/vscode/src/commands/open-terminal-ref.ts` — **new**. `openTerminalRef(cm, ref)`: discriminator
  + delegation to the three reuse helpers + setting read.
- `apps/vscode/src/terminal-link-provider.ts` — add `IssueRefTerminalLinkProvider` (+ `IssueRefLink`),
  import `openTerminalRef` and `ConnectionManager` type.
- `apps/vscode/src/extension.ts:~1450` — register the provider (one `push`, beside the existing two).
- `apps/vscode/package.json` — add `codev.terminalLinks.issueTarget` under
  `contributes.configuration.properties`.
- `apps/vscode/src/__tests__/terminal-ref-link-provider.test.ts` — **new**. Detection + resolution tests.

Out of scope (issue's follow-ups): Tower web-dashboard xterm terminals (#1217-adjacent) and an
in-editor PR preview surface.

## Risks & Alternatives Considered

- **Double fetch on a bare `#N` click** (discriminator `getIssue`, then the helper re-fetches):
  accepted. It is one extra round-trip on a single deliberate click; funneling every open through the
  one sanctioned helper (single owner per destination) is worth more than saving it.
  - *Alternative (rejected):* thread the preloaded `IssueView` into `viewBacklogIssue`/`openPRInBrowser`
    to skip the re-fetch — expands their signatures for a non-user-visible micro-opt; against "lean."
  - *Alternative (rejected):* `openExternal(issue.url)` directly for the discriminated-PR case (saves the
    `getPR`) — creates a second browser-open path; consistency with the explicit `PR #N` branch wins.
- **Over-claiming spans** (e.g. `#2` in "step #2"): accepted. Cmd+click is opt-in; a stray click yields
  a warning toast at worst. Hex colors and spaced `# 1` headings already don't match.
- **Non-GitHub forge with no `url`**: discriminator can't tell issue from PR; degrades to the issue
  path (`viewBacklogIssue`). v1 targets GitHub, where `url` is always present.
- **Shared-`RegExp` reentrancy**: avoided by constructing the regex per call (d.ts explicitly warns
  against the module-level shared pattern the sibling provider uses).

## Test Plan

**Unit (`terminal-ref-link-provider.test.ts`, vitest, `vi.mock('vscode')` + the three helper modules —
established pattern from `open-issue-by-id.test.ts` / `reconnect-link-provider.test.ts`):**

- Detection:
  - ordinary line → no links.
  - `#915` → one link, `{number:'915', isPR:false}`, span == `#915`.
  - `PR #1402` → one link, `{number:'1402', isPR:true}`, span == `PR #1402`.
  - `see #12 and PR #34` → two links, correct flags/spans, inner `#34` claimed once (not double).
  - `#fff` and `# 1` → no links.
- Resolution routing (fake `connectionManager` with controllable `client.getIssue`; assert which helper is called):
  - explicit PR ref → `openPRInBrowser`; `getIssue` **not** called.
  - bare `#N`, `getIssue` url `/issues/`, setting `editor` → `viewBacklogIssue`.
  - bare `#N`, `getIssue` url `/issues/`, setting `browser` → `openIssueInBrowser`.
  - bare `#N`, `getIssue` url `/pull/` → `openPRInBrowser` (PR fallthrough).
  - `getIssue` → null → warning toast, no helper called.
  - not connected → error toast.

**Manual (dev-approval gate — live check in a real architect terminal on this workspace):**

- In an architect terminal, Cmd+click `#1412` → in-editor issue preview opens (default `editor`).
- Cmd+click `PR #1405` → browser opens `.../pull/1405`.
- Cmd+click a bare number that is actually a PR (e.g. `#1405`) → browser opens the PR page (fallthrough).
- Set `codev.terminalLinks.issueTarget: browser`, Cmd+click `#1412` → browser opens the issue.
- Cmd+click a nonexistent number → warning toast; no silent fallthrough to workspace search.
- Line with two refs → both are individually clickable.

**Build/verify:** `pnpm --filter codev-vscode build` and the vitest suite from the worktree.
