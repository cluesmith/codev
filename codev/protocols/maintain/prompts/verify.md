# VERIFY Phase Prompt

You are executing the **VERIFY** phase of the MAINTAIN protocol.

## Your Goal

Run final validation and prepare for PR creation.

## Context

- **Current State**: {{current_state}}

## Process

### 1. Run Full Test Suite

```bash
npm run build
npm test
```

Both must pass. If either fails, go back and fix the issue.

### 2. Run Linting

```bash
npm run lint 2>/dev/null || echo "No lint script"
```

Fix any linting errors.

### 3. Verify Documentation Links

Check that documentation references resolve:
```bash
# Check arch.md file references
grep -oE 'src/[^ ]+|packages/[^ ]+' codev/resources/arch.md | while read f; do
  [ -e "$f" ] || echo "Missing: $f"
done
```

### 4. Update Maintenance Run Summary

Finalize the maintenance run file with:

```markdown
## Summary

- **Dead code removed**: X files, Y functions
- **Dependencies removed**: Z packages
- **Documentation updated**: arch.md, lessons-learned.md
- **All tests passing**: Yes/No
- **Build status**: Success/Failure

## Next Maintenance

Recommended focus areas for next run:
- ...
```

### 5. Create PR

```bash
git push origin HEAD

gh pr create --title "[Maintain] Codebase maintenance run NNN" --body "$(cat <<'EOF'
## Summary

- Dead code removal
- Documentation sync
- Dependency cleanup

## Changes

[List key changes]

## Verification

- [x] Build passes
- [x] Tests pass
- [x] Documentation updated
EOF
)"
```

## Validation Checklist

Before signaling complete:

- [ ] All tests pass
- [ ] Build succeeds
- [ ] No import/module errors
- [ ] Documentation links resolve
- [ ] Linter passes (if configured)
- [ ] Maintenance run file is complete
- [ ] PR is created

## Signals

When validation passes and PR is ready:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
