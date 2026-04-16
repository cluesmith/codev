# Spec 671: Hermes Consult Backend (Optional, Not Default)

## Problem
Codev consult supported Gemini, Codex, and Claude, but did not support Hermes. Teams that use Hermes (including pay-as-you-go workflows) could not use `consult -m hermes`.

A second problem appeared during rollout: documentation examples drifted toward 4-way default review, which conflicts with Codev defaults and intended model positioning.

## Desired State
Add Hermes as an additional consult backend while preserving current default behavior.

## Requirements
1. `consult -m hermes` must be supported in CLI routing.
2. Porch consultation model validation must accept `hermes` when explicitly configured.
3. Default consultation fan-out must remain unchanged (`gemini`, `codex`, `claude`).
4. Hermes prompt transport must avoid ARG_MAX/E2BIG failures for large prompts.
5. Docs must present Hermes as optional and keep source/skeleton docs synchronized.
6. Tests must cover model acceptance and large-prompt behavior.

## Non-Goals
- Changing default consultation models to 4-way.
- Adding shorthand alias for Hermes in this iteration.

## Success Criteria
- [ ] Hermes model works in consult command.
- [ ] Large prompts are handled without inline-arg overflow failures.
- [ ] Default model configuration remains 3-way.
- [ ] Docs in `codev/` and `codev-skeleton/` match and state Hermes is optional.
- [ ] Relevant tests pass.

## Risks
- Documentation can drift from runtime defaults.
- Backend-specific prompt transport can regress and reintroduce E2BIG.

## Mitigations
- Add explicit tests for Hermes large-prompt path.
- Keep docs examples aligned with `packages/codev/src/lib/config.ts` defaults.

## References
- Issue: https://github.com/cluesmith/codev/issues/671
- PR: https://github.com/cluesmith/codev/pull/670
