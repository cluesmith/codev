# Spec 438: ASPIR Protocol — Autonomous SPIR

## Summary

Create a new protocol called ASPIR (Autonomous SPIR) that is identical to SPIR except the spec-approval and plan-approval gates are auto-approved. Everything else (phases, consultations, checks, PR flow) remains the same.

## Motivation

For trusted/low-risk work, the human approval gates add latency without adding value. ASPIR lets builders run fully autonomously from spec through merge while still following the full SPIR discipline (consultations, phase checks, reviews).

## Requirements

1. Copy the full SPIR protocol (protocol.json, protocol.md, builder-prompt.md, prompts/, consult-types/, templates/)
2. Remove the `spec-approval` and `plan-approval` gates from the protocol definition
3. Keep all phases, checks, consultations, and PR flow identical to SPIR
4. Add ASPIR to the protocol selection guide in CLAUDE.md/AGENTS.md
5. Support `af spawn N --protocol aspir`
