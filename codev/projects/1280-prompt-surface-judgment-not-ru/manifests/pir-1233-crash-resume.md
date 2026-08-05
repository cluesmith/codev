# PIR #1233 — builder crash-restart resumes the session (prompt-bearing doc touches)

Not a Spec 1280 phase: this branch makes the builder launch loop resume the
pinned conversation after a crash instead of respawning fresh (issue #1233). It
touches four prompt-bearing files — the PIR builder prompt and protocol in both
trees — with mechanical accuracy updates: the "crash relaunches you with the
same prompt" wording was made false by the code change and now describes the
resume-with-nudge behavior plus its degrade fallback. No prompt-surface-reduction
principles were applied; the deltas add the minimum words needed to keep the
docs truthful.

| File | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `codev/protocols/pir/builder-prompt.md` | 898 | 941 | none | Resumption After Crash section: crash now resumes with context + nudge; fresh relaunch is the degrade fallback |
| `codev/protocols/pir/protocol.md` | 2066 | 2114 | none | Builder Session Lifetime: loop pins a session id, resumes on crash, degrades to prompt replay when unresumable |
| `codev-skeleton/protocols/pir/builder-prompt.md` | 898 | 941 | none | Mirror of the codev/ change (both trees byte-identical) |
| `codev-skeleton/protocols/pir/protocol.md` | 2066 | 2114 | none | Mirror of the codev/ change (both trees byte-identical) |
