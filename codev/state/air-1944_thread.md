# air-1944 thread: Node floor 22

- Architect (main) confirmed both open questions: all five POSIX workflows go 20 -> 22; the Node 20 install-guard leg is removed (issue default). Architect is reporting both readings to the owner and will flag any change before the pr gate.
- Windows workflow: every job on Node 22. Probe matrix is now `os: [windows-latest, windows-11-arm]` only; artifact names lost their `-node<N>` suffix. Install guard keeps only the `--supported` check; `windows-install-guard-check.mjs` still has its `--control`/`--unsupported` modes for manual use.
- Guard message: "Node.js 22 (LTS), x64 or arm64" in both twins; ABI allow list unchanged (24/25/26 still install).
- No tracked `.npmrc` sets `engine-strict`, so a below-floor install on POSIX warns (EBADENGINE) and proceeds; on native Windows the preinstall guard still refuses an ABI with no prebuild.
- Adjacent fix: `codev doctor` checked Node >= 18.0.0; now 22.0.0, with a Node 20 failure test. Doctor test fixtures moved from v20 to v22.
- PR #1962. CMAP (codex, claude) and the architect's integration review found more stale floor references and doc nits; all fixed. Doctor's Linux hint and the DEPENDENCIES.md apt block now use NodeSource setup_22.x.
- Item 6, owner ruling: the Node 20 install-guard refusal leg stays dropped. Comments now say the real install abort is no longer checked on a Windows host (the unit tests cover the decision and message only).
