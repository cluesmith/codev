# INVESTIGATE Phase Prompt

You are executing the **INVESTIGATE** phase of the BUGFIX protocol.

## Goal

Understand the bug, reproduce it, find the root cause, and decide whether it fits BUGFIX scope (a focused change under ~300 LOC).

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## What must be true when you finish

- **The bug is reproduced, not assumed.** You have confirmed the expected-vs-actual behavior from the issue and established concrete reproduction steps (inferring them if the issue gives none). If you cannot reproduce it, tell the architect what you tried and stop.
- **The root cause is understood** — the exact file(s) and line(s), and *why* the bug happens, not just where. Trace the failure path rather than pattern-matching a symptom.
- **The scope is assessed against BUGFIX's ceiling.** A focused fix under ~300 LOC proceeds; anything architectural (new abstractions, refactors, cascading effects across many files) goes to the architect with a recommendation to escalate. ~300 LOC is a guideline, not a hard limit.

## When you finish

- **Root cause and fix scope known:** run the `porch done` command porch gives you below.
- **Too large or architectural for BUGFIX, or blocked** (cannot reproduce, missing context): do not
  run `porch done`. Send the specifics, then stop and wait:
  ```bash
  afx send architect "Issue #<N>: <what you found>. Recommend escalating to SPIR."   # or: Blocked on <X>
  ```
