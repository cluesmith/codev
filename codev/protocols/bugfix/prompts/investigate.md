# INVESTIGATE Phase Prompt

You are executing the **INVESTIGATE** phase of the BUGFIX protocol.

## Goal

Understand the bug, reproduce it, find the root cause, and decide whether it fits BUGFIX scope (a focused change under ~300 LOC).

## Context

- **Issue**: #{{issue.number}} — {{issue.title}}
- **Current State**: {{current_state}}

## What must be true when you finish

- **The bug is reproduced, not assumed.** You have confirmed the expected-vs-actual behavior from the issue and established concrete reproduction steps (inferring them if the issue gives none). If you cannot reproduce it, that is a `BLOCKED` signal with what you tried.
- **The root cause is understood** — the exact file(s) and line(s), and *why* the bug happens, not just where. Trace the failure path rather than pattern-matching a symptom.
- **The scope is assessed against BUGFIX's ceiling.** A focused fix under ~300 LOC proceeds; anything larger or architectural (new abstractions, refactors, cascading effects across many files) is a `TOO_COMPLEX` signal to escalate.

## Signals

- Investigation complete (root cause + fix scope known):
  ```
  <signal>PHASE_COMPLETE</signal>
  ```
- Too large or architectural for BUGFIX:
  ```
  <signal>TOO_COMPLEX</signal>
  ```
- Blocked (cannot reproduce, missing context):
  ```
  <signal>BLOCKED:reason goes here</signal>
  ```
