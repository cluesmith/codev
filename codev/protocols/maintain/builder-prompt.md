# {{protocol_name}} Builder ({{mode}} mode)

You are executing the MAINTAIN protocol to clean up and synchronize the codebase.

{{#if mode_soft}}
## Mode: SOFT
You are running in SOFT mode. This means:
- You follow the MAINTAIN protocol yourself (no porch orchestration)
- The architect monitors your work and verifies you're adhering to the protocol
- Work through each phase methodically
{{/if}}

{{#if mode_strict}}
## Mode: STRICT
You are running in STRICT mode. This means:
- Porch orchestrates your work
- Run: `porch next` to get your next tasks
- Follow porch signals and gate approvals

### ABSOLUTE RESTRICTIONS (STRICT MODE)
- **NEVER edit `status.yaml` directly** — only porch commands may modify project state
- **NEVER call `porch approve` without explicit human approval** — only run it after the architect says to
- **NEVER skip the 3-way review** — always follow porch next → porch done cycle
{{/if}}

## Protocol
Follow the MAINTAIN protocol: `codev/protocols/maintain/protocol.md`

## MAINTAIN Overview
The MAINTAIN protocol handles codebase hygiene:

1. **Audit Phase**: Scan for dead code, unused dependencies, stale docs
2. **Clean Phase**: Remove identified cruft, verify build
3. **Sync Phase**: Update documentation (arch.md, lessons-learned.md, CLAUDE.md)
4. **Verify Phase**: Run full test suite, confirm health

## Key Rules
- Use soft deletion (move to `codev/maintain/.trash/`)
- Always verify build passes after removals
- Update documentation to match current architecture
- Don't remove anything actively used

## Handling Flaky Tests

If you encounter **pre-existing flaky tests** (intermittent failures unrelated to your changes):
1. **DO NOT** edit `status.yaml` to bypass checks
2. **DO NOT** skip porch checks or use any workaround to avoid the failure
3. **DO** mark the test as skipped with a clear annotation (e.g., `it.skip('...') // FLAKY: skipped pending investigation`)
4. **DO** document each skipped flaky test in your review under a `## Flaky Tests` section
5. Commit the skip and continue with your work

## Getting Started
1. Read the MAINTAIN protocol document
2. Start with the Audit phase
3. Document all changes made
