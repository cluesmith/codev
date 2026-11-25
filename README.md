# Spec 1963 evidence (Codev Cockpit, PR #1971)

This branch holds the rendered-verification evidence for Spec 1963: screenshots, check results
(JSON) and the layout spike's screenshots. It is **never merged**. Evidence binaries are kept out of
`main`'s tree, and the PR branch links here by commit SHA. On the PR branch,
`codev/projects/1963-vscode-alternative-layout-seco/verification.md` lists every check with its
result and a permalink into this branch.

| Folder | Run |
|---|---|
| `verification-final/1.147.0-serve-web/` | VS Code 1.147.0 serve-web (server commit `8a14f0cc1b08d531eb83255ea3764ae22aa932b5`): every verify script |
| `verification-final/1.138.0/` | Codev IDE 1.138.0's VS Code Server (commit `50cad256c2ef6d8d156631d1386f12befae4f5f2`), fenced: `webviews`, `arrange`, `work`, `decisions` |
| `verification-final/1.128.0/` | VS Code Server 1.128.0 (commit `fc3def6774c76082adf699d366f31a557ce5573f`), fenced: `arrange`, `work`, `decisions` |
| `layout-spike/` | The plan's layout spike (VS Code 1.147.0) |

Every run in `verification-final/` is on one of two heads, named in its folder's `head.txt`:
- `d31df3a84`, with the vsix built at `7cdc24716` (the one commit between them changes only the
  harness): every script that renders the Work or Decisions panel (on 1.147.0 `decisions`, `work`,
  `arrange`, `webviews`; on 1.138.0 and 1.128.0, every run);
- `35334efbf`, with the vsix built at `4ab7ed1d4` (the one commit between them changes only the
  harness, which is not a vsix input): the nine scripts that render no panel.

Between the two heads the vsix inputs changed only in the panels' stylesheet and its test; the PR
branch's `verification.md` gives the `git diff --stat`. Each script folder holds that run's results
JSON, any capture file it wrote, and exactly the screenshots its JSON names. Each `_session-*` folder holds the tripwire's log for that session's start: the
samples it logged, each reading "no connection on :4100". "Fenced" means the server ran
inside the harness's `sandbox-exec` profile, which refuses outbound TCP to the owner's Tower port;
a canary proves the profile applies at every start.

Every screenshot here was read with OCR, and none shows a machine's shell prompt.

On 1.138.0 three `webviews` checks fail, as expected: VS Code's own Markdown preview, the
contextual panel and the Codev Markdown preview stay blank there because of the IDE defect
cluesmith/codev-ide#67. The Work and Decisions panels carry their code inline and render.

The per-phase folders this branch held before (`verification-increment1/` and
`verification-phase6/` to `verification-phase9/`) are replaced by these final-head runs; they stay in
this branch's history.
