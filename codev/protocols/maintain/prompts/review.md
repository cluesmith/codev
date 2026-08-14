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

export CODEV_PR_TITLE="[Maintain] Codebase maintenance run NNNN"
export CODEV_PR_BODY="$(cat <<'PREOF'
## Summary

<2-3 bullet points of what was done>

Closes #<N>  <!-- Only if this run was triggered by a GitHub issue. Use "Refs #<N>" for partial cleanup. -->

## Changes

- Dead code removed: X items
- Dependencies cleaned: Y packages
- Documentation updated: arch.md / arch-critical.md, lessons-learned.md / lessons-critical.md (hot + cold tiers; hot caps + cold-doc maps policed)
- Tests: all passing

## Test plan

- [x] Build passes
- [x] All tests pass
- [x] Documentation links resolve
PREOF
)"

{{pr_create_command}}
```

The command above is your forge's `pr-create` concept, substituted by porch (`gh pr create` by default). It takes `CODEV_PR_TITLE` / `CODEV_PR_BODY` — optionally `CODEV_PR_BASE`, `CODEV_PR_HEAD`, `CODEV_PR_REPO` — from the environment, which is why they are exported rather than prefixed onto the command line: an inline override that spells `--title "$CODEV_PR_TITLE"` needs them set in the calling shell too. It prints `{"number": <int>, "url": "<url>"}`.

## Signals

When PR is created:

```
<signal>PHASE_COMPLETE</signal>
```

If blocked:

```
<signal>BLOCKED:reason</signal>
```
