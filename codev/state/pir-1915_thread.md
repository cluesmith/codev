# pir-1915 thread

## 2026-11-23 — plan
- Plan at codev/plans/1915-windows-show-and-end-orphaned-.md.
- Orphan = member of the session's Job Object, not the root shellper, whose parent pid is gone or reused (parent created after it). Parent unopenable => never listed.
- Helper gains `snapshot` (Toolhelp pid/ppid/name, shaped for later liveness-sweep reuse; sweep untouched), `job-processes`, `end-process` (kernel-side job + creation-time check).
- Tower routes GET /api/orphans, POST /api/orphans/end (husk-sweep precedent); `afx orphans [agent] [--apply] [-y]`; afx status + codev doctor sections, Windows only.
- Observed this session's tree: shellper -> conhost, bash(launch loop) -> bash -> bash -> claude.exe.
- Architect notes: no AI attribution anywhere; no auto-ending; full suite one at a time with bugfix-1910.
