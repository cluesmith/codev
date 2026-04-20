# REVIEW Phase Prompt

You are executing the **review** phase of the MAINTAIN protocol.

## Context

- **Current State**: {{current_state}}

## Process

### 1. Final Validation

```bash
cd packages/codev && pnpm build && pnpm test
```

Both must pass. If either fails, fix before proceeding.

### 2. Verify Documentation Links

```bash
grep -oE '[a-zA-Z]+/[a-zA-Z/]+\.[a-z]+' codev/resources/arch.md | sort -u | while read f; do
  [ -e "$f" ] || echo "Missing: $f"
done
```

### 3. Finalize Maintenance Run File

Update `codev/maintain/NNNN.md` with:
- PR number (once created)
- Final summary of what was done
- Deferred items (if any)

### 4. Create PR

**PR body requirements**: If this maintenance run was triggered by a GitHub issue
(e.g. "track down dead X", "clean up Y module"), the PR body MUST include
`Closes #<N>` for that issue so GitHub auto-closes it on merge. If multiple
issues are addressed in one run, include one `Closes #<N>` per issue.

**Exception**: if this PR only partially addresses a tracking issue (e.g. more
cleanup passes are planned), use `Refs #<N>` or `Part of #<N>` instead.

If the run was not tied to any issue, the `Closes` line can be omitted.

```bash
git push origin HEAD

gh pr create --title "[Maintain] Codebase maintenance run NNNN" --body "$(cat <<'PREOF'
## Summary

<2-3 bullet points of what was done>

Closes #<N>  <!-- Only if this run was triggered by a GitHub issue. Use "Refs #<N>" for partial cleanup. -->

## Changes

- Dead code removed: X items
- Dependencies cleaned: Y packages
- Documentation updated: arch.md, lessons-learned.md
- Tests: all passing

## Test plan

- [x] Build passes
- [x] All tests pass
- [x] Documentation links resolve
PREOF
)"
```

## Signals

When PR is created:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
