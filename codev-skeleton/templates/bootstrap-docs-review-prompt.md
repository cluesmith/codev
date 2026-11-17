You are reviewing a first draft of the Codev governance docs for the project **{{PROJECT_NAME}}**. An agent drafted them from this repository's code and git history; a human will read your review before committing anything. Do not edit any file. Report only.

The governance docs come in two tiers. The cold docs (`arch.md`, `lessons-learned.md`) are on-demand reference. The hot docs (`arch-critical.md`, `lessons-critical.md`) are injected into every agent prompt, so each one is capped (at most 10 entries, at most 12 map entries, at most 35 lines outside HTML comments) and carries a "consult when…" map whose entries name real top-level sections of its cold doc.

## The drafts

{{DRAFTS}}

## What to check

Check the drafts against the repository itself (read the code and run read-only git commands as needed), and report:

1. **System-shape accuracy.** Statements in `arch.md` or `arch-critical.md` that the code contradicts, or major parts of the system (processes, persistence, transports, build wiring) the drafts leave out.
2. **Invented or unevidenced lessons.** Lessons with no trace in the code, comments or git history. A thin lessons file is acceptable; an invented lesson is not.
3. **Content the docs must not hold.** Per-file enumerations, per-commit or per-spec changelog narration, and aspirational or planned state described as current.
4. **Hot-tier problems.** An entry that is not load-bearing enough to be always-on, a load-bearing fact left only in the cold doc, a map entry that does not match a cold section, or a cap that is exceeded.
5. **Sensitive material.** Credentials, tokens, keys, internal hostnames or endpoints, connection strings, or customer data, even as examples. Name the file and line; this is the most important check.

For each finding, name the file, quote the text, and say what should change. End with a one-line overall judgement of whether the drafts are ready for the human to review and commit.
