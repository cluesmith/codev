# Specification: Consult PR Mode

## Metadata
- **ID**: 0038-consult-pr-mode
- **Protocol**: TICK
- **Status**: spec-draft
- **Created**: 2025-12-07
- **Priority**: medium

## Problem Statement

The current `consult` tool works well for general queries, but when reviewing Pull Requests, the consultant models (especially Codex) waste time running repetitive git commands. Recent analysis shows:

- **Codex runs 19+ git commands** during PR reviews (multiple `git show <branch>:<file>` calls)
- **Total consultation time**: 200-250 seconds
- **Context waste**: Repeated fetching of the same PR data
- **Performance bottleneck**: Sequential git command execution

**Optimized approach** (tested in practice):
- Pre-fetch PR data once (6 commands total)
- Save to temporary files
- Pass file paths to consultant
- Extract just the verdict (~last 50 lines)
- **Result**: 138 seconds (30%+ faster)

## Current State

`codev/bin/consult` supports:
- Three providers: gemini, codex, claude
- General queries via stdin or command-line arguments
- Role definition from `codev/roles/consultant.md`
- Autonomous mode flags (`--yolo`, `--full-auto`, `--dangerously-skip-permissions`)
- Query logging with timing to `.consult/history.log`

**Current PR review workflow** (manual):
```bash
# User prepares context manually
gh pr view 33 > /tmp/pr-info.txt
gh pr diff 33 > /tmp/pr-diff.txt

# Then runs consult with context
./codev/bin/consult gemini "Review PR 33. Info: $(cat /tmp/pr-info.txt)"
```

## Desired State

```bash
# Simple, optimized PR review
./codev/bin/consult pr 33

# Or with specific model
./codev/bin/consult pr 33 --model gemini
./codev/bin/consult pr 33 --model codex
./codev/bin/consult pr 33 --model claude

# Or consult all three in parallel (3-way review)
./codev/bin/consult pr 33 --all

# Dry run to see what would be fetched
./codev/bin/consult pr 33 --dry-run
```

**Optimized workflow**:
1. Pre-fetch PR data (6 commands):
   - `gh pr view N` - PR metadata
   - `gh pr view N --comments` - Review comments
   - `gh pr diff N` - Full patch
   - `gh pr view N --json files` - Changed files
   - Find associated spec file (if exists): `codev/specs/NNNN-*.md`
   - Find associated plan file (if exists): `codev/plans/NNNN-*.md`
2. Save to temporary files in `.consult/pr-NNNN/`
3. Pass file paths to consultant with structured query
4. Stream full output to `.consult/pr-NNNN/<model>-full.txt`
5. Extract verdict (last ~50 lines containing VERDICT/APPROVE/REQUEST_CHANGES)
6. Print verdict to stdout
7. Report timing and file locations

## Scope

### In Scope
- New `pr` subcommand for `consult` tool
- Pre-fetch PR data to temporary files
- Support all three providers (gemini, codex, claude)
- `--all` flag for parallel 3-way review
- `--model` flag to specify single model (defaults to all three)
- Extract and display verdict from consultation output
- Save full output to files for reference
- Timing reports
- Automatic cleanup of old PR consultation directories (keep last 10)

### Out of Scope
- Interactive PR review (this is read-only analysis)
- Automatic PR approval/rejection
- Integration with GitHub Actions
- Caching of PR data beyond single consultation
- Multi-PR batch reviews
- Custom verdict parsing rules

## Success Criteria

- [ ] `./codev/bin/consult pr N` fetches PR data and runs consultation
- [ ] Pre-fetch reduces total git commands from 19+ to 6
- [ ] Full output saved to `.consult/pr-NNNN/<model>-full.txt`
- [ ] Verdict extracted and printed to stdout
- [ ] Timing shows 30%+ improvement over naive approach
- [ ] `--all` flag runs all three models in parallel
- [ ] `--model` flag selects specific model
- [ ] Works with all three providers (gemini, codex, claude)
- [ ] Handles missing spec/plan files gracefully
- [ ] Old consultation directories automatically cleaned up

## Technical Approach

### Command Structure

Add new subcommand to `codev/bin/consult` using Typer's command groups:

```python
import typer

app = typer.Typer()

@app.command()
def consult(model: str, query: str, ...):
    """Original consult command (existing)"""
    pass

@app.command()
def pr(
    number: int,
    model: str = typer.Option(None, "--model", "-m"),
    all_models: bool = typer.Option(False, "--all", "-a"),
    dry_run: bool = typer.Option(False, "--dry-run", "-n"),
):
    """Consult on a Pull Request with optimized data fetching."""
    pass
```

### Pre-fetch Implementation

**Fetch commands** (sequential, ~10-15 seconds total):
```python
def fetch_pr_data(pr_number: int, output_dir: Path) -> dict:
    """Fetch PR data and save to files. Returns metadata."""
    metadata = {}

    # 1. PR info
    run(["gh", "pr", "view", str(pr_number)],
        stdout=output_dir / "pr-info.txt")

    # 2. Comments
    run(["gh", "pr", "view", str(pr_number), "--comments"],
        stdout=output_dir / "pr-comments.txt")

    # 3. Diff
    run(["gh", "pr", "diff", str(pr_number)],
        stdout=output_dir / "pr-diff.patch")

    # 4. Files list
    files_json = run(["gh", "pr", "view", str(pr_number),
                      "--json", "files"], capture=True)
    metadata["files"] = json.loads(files_json)

    # 5. Spec file (if exists)
    # Extract project number from PR title or branch name
    # Look for codev/specs/NNNN-*.md
    spec_path = find_spec_file(pr_number)
    if spec_path:
        shutil.copy(spec_path, output_dir / "spec.md")
        metadata["spec"] = str(spec_path)

    # 6. Plan file (if exists)
    plan_path = find_plan_file(pr_number)
    if plan_path:
        shutil.copy(plan_path, output_dir / "plan.md")
        metadata["plan"] = str(plan_path)

    return metadata
```

### Query Construction

```python
def build_pr_query(pr_number: int, data_dir: Path, metadata: dict) -> str:
    """Build structured query for consultant."""
    query = f"""Review Pull Request #{pr_number}

Available data files:
- PR Info: {data_dir}/pr-info.txt
- Comments: {data_dir}/pr-comments.txt
- Diff: {data_dir}/pr-diff.patch
- Files: {len(metadata['files'])} files changed
"""

    if "spec" in metadata:
        query += f"- Spec: {data_dir}/spec.md\n"
    if "plan" in metadata:
        query += f"- Plan: {data_dir}/plan.md\n"

    query += """
Please review:
1. Code quality and correctness
2. Alignment with spec/plan (if provided)
3. Test coverage
4. Edge cases and error handling
5. Documentation

End your review with a verdict in this format:

VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
SUMMARY: [One-line summary]
CONFIDENCE: [HIGH | MEDIUM | LOW]
"""

    return query
```

### Verdict Extraction

```python
def extract_verdict(full_output: str) -> str:
    """Extract verdict section from consultation output.

    Returns last ~50 lines containing VERDICT marker.
    If no VERDICT found, returns last 50 lines.
    """
    lines = full_output.split("\n")

    # Find VERDICT marker
    for i, line in enumerate(lines):
        if "VERDICT:" in line.upper():
            # Return from VERDICT to end (or up to 50 lines)
            return "\n".join(lines[i:min(i+50, len(lines))])

    # Fallback: return last 50 lines
    return "\n".join(lines[-50:])
```

### Parallel Execution (--all flag)

```python
def consult_all_models(pr_number: int, data_dir: Path, query: str):
    """Run all three models in parallel."""
    import concurrent.futures

    models = ["gemini", "codex", "claude"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(run_consultation, model, query, data_dir): model
            for model in models
        }

        for future in concurrent.futures.as_completed(futures):
            model = futures[future]
            try:
                verdict = future.result()
                print(f"\n{'='*60}")
                print(f"{model.upper()} VERDICT")
                print(f"{'='*60}")
                print(verdict)
            except Exception as e:
                print(f"{model} failed: {e}", file=sys.stderr)
```

### Output Structure

```
.consult/
├── history.log                    # Existing query log
└── pr-0033/                       # PR-specific directory
    ├── pr-info.txt               # Fetched data
    ├── pr-comments.txt
    ├── pr-diff.patch
    ├── spec.md                   # If found
    ├── plan.md                   # If found
    ├── gemini-full.txt           # Full output
    ├── gemini-verdict.txt        # Extracted verdict
    ├── codex-full.txt
    ├── codex-verdict.txt
    ├── claude-full.txt
    └── claude-verdict.txt
```

### Cleanup Strategy

```python
def cleanup_old_pr_consultations(consult_dir: Path, keep_last: int = 10):
    """Keep only the N most recent PR consultation directories."""
    pr_dirs = sorted(
        [d for d in consult_dir.glob("pr-*") if d.is_dir()],
        key=lambda d: d.stat().st_mtime,
        reverse=True
    )

    for old_dir in pr_dirs[keep_last:]:
        shutil.rmtree(old_dir)
```

## Implementation Steps

1. **Add pr subcommand structure** (~5 min)
   - Use Typer command groups
   - Add argument parsing (number, --model, --all, --dry-run)

2. **Implement data fetching** (~15 min)
   - `fetch_pr_data()` function
   - Handle missing spec/plan gracefully
   - Save to `.consult/pr-NNNN/` directory

3. **Implement query construction** (~10 min)
   - Build structured query with file paths
   - Include verdict format instructions

4. **Add verdict extraction** (~10 min)
   - Parse VERDICT marker from output
   - Fallback to last 50 lines if no marker

5. **Wire up consultation flow** (~15 min)
   - Stream to full output file
   - Extract verdict
   - Print verdict to stdout
   - Report timing

6. **Add parallel execution** (~10 min)
   - `--all` flag implementation
   - ThreadPoolExecutor for 3-way review
   - Formatted output for multiple verdicts

7. **Add cleanup** (~5 min)
   - Automatic cleanup of old PR directories
   - Keep last 10 by default

8. **Test all paths** (~15 min)
   - Single model consultation
   - All models in parallel
   - Missing spec/plan handling
   - Dry run mode
   - Verify timing improvement

## Testing Approach

**Manual testing** (no automated tests for this iteration):

```bash
# Test single model
./codev/bin/consult pr 33 --model gemini

# Test all models
./codev/bin/consult pr 33 --all

# Test dry run
./codev/bin/consult pr 33 --dry-run

# Verify files created
ls -lah .consult/pr-0033/

# Verify timing improvement
# Compare: old approach (200s+) vs new approach (target: <150s)
```

**Success metrics**:
- Pre-fetch completes in <15 seconds
- Total consultation time < 150 seconds (vs 200s+ baseline)
- Verdict extraction works for all three models
- Clean output files in `.consult/pr-NNNN/`

## Dependencies

- `codev/bin/consult` - Existing tool (project 0022)
- `gh` CLI - GitHub CLI for PR data
- `codev/roles/consultant.md` - Role definition
- Python libraries: `typer`, `concurrent.futures`, `subprocess`, `json`, `shutil`

## Assumptions

- GitHub CLI (`gh`) is installed and authenticated
- PR numbers are valid and accessible
- Consultant models follow verdict format instructions
- Network latency for PR fetching is reasonable (<15s)
- Spec/plan files follow naming convention `codev/specs/NNNN-*.md`

## Non-Goals

- Real-time PR monitoring (this is on-demand)
- Integration with CI/CD pipelines
- Multi-repository support
- Custom verdict templates per project
- Persistent caching of PR data

## Future Enhancements (Not This Spec)

- **PR watch mode**: Monitor PRs and auto-consult on updates
- **Custom verdict formats**: Project-specific verdict templates
- **Integration with agent-farm**: Notify builders of PR reviews
- **Batch mode**: Review multiple PRs at once
- **Delta reviews**: Only review changed lines since last review
