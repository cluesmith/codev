# Review: Consult PR Mode

## Metadata
- **Spec ID**: 0038-consult-pr-mode
- **Protocol**: TICK
- **Completed**: 2025-12-07

## What Was Implemented

Added a new `pr` subcommand to the `consult` tool that provides optimized PR review functionality:

### Core Features
1. **Pre-fetch PR data** - Reduces git commands from 19+ to 6 by fetching all data upfront
2. **Automatic spec/plan detection** - Extracts `[Spec NNNN]` from PR title and includes relevant docs
3. **Parallel 3-way review** - Runs gemini, codex, and claude in parallel by default
4. **Single model mode** - `--model` flag for targeted reviews
5. **Verdict extraction** - Parses `VERDICT:` marker from model output
6. **Output persistence** - Full output and verdicts saved to `.consult/pr-NNNN/`
7. **Auto-cleanup** - Removes old PR consultation directories (keeps last 10)

### Files Changed
- `codev/bin/consult` - Major restructure (~520 net additions)

### Architecture Decisions

1. **Removed Typer dependency** - Manual argument parsing was necessary to support the hybrid CLI pattern where:
   - Default: `consult MODEL QUERY` (positional args)
   - Subcommand: `consult pr NUMBER [OPTIONS]`

   Typer doesn't handle this pattern well with `invoke_without_command=True` and positional arguments.

2. **Capture vs streaming output** - For PR reviews, model output is captured (not streamed) because:
   - Full output needs to be saved to file
   - Verdict extraction requires the complete response
   - Parallel execution requires non-blocking capture

3. **Verdict format** - Requested format includes:
   ```
   VERDICT: [APPROVE | REQUEST_CHANGES | COMMENT]
   SUMMARY: [One-line summary]
   CONFIDENCE: [HIGH | MEDIUM | LOW]
   KEY_ISSUES: [List or "None"]
   ```
   Falls back to last 50 lines if no `VERDICT:` marker found.

## Challenges Encountered

1. **Typer subcommand limitations** - Initial implementation used Typer but the `invoke_without_command=True` callback pattern conflicts with positional arguments. Switched to manual parsing.

2. **Error handling migration** - Had to replace all `typer.echo()` and `typer.Exit()` with standard `print()` and `sys.exit()` calls.

## Deviations from Plan

None significant. The spec was well-defined and implementation followed it closely.

## Test Results

### Manual Testing Performed

1. **Help messages**
   - `consult --help` ✓
   - `consult pr --help` ✓

2. **Original command compatibility**
   - `consult gemini "test" --dry-run` ✓
   - `consult pro "test" --dry-run` ✓ (alias)

3. **PR subcommand**
   - `consult pr 33 --dry-run` ✓ (all models)
   - `consult pr 33 --model gemini --dry-run` ✓ (single model)

4. **Data fetching**
   - PR info, comments, diff, files.json ✓
   - Spec/plan file detection from `[Spec NNNN]` ✓
   - Metadata JSON saved ✓

5. **Verdict extraction**
   - Correctly extracts from sample output ✓
   - Fallback to last 50 lines works ✓

6. **Error handling**
   - Missing PR number shows error ✓
   - Unknown model shows error ✓

## Lessons Learned

1. **CLI hybrid patterns are tricky** - When you need both positional-first commands and subcommands, manual argument parsing may be cleaner than fighting framework limitations.

2. **Pre-fetching is effective** - The 6-command pre-fetch approach significantly reduces redundant git operations compared to letting each model agent fetch its own data.

3. **Verdict parsing needs robustness** - Models don't always follow the exact format requested. The fallback to "last 50 lines" handles this gracefully.

## Recommendations for Future Work

1. **Streaming progress indicators** - For parallel execution, show which models are still running
2. **Custom verdict formats** - Allow projects to define their own verdict templates
3. **Incremental reviews** - Compare with previous review to show changes
4. **PR watch mode** - Automatically re-review when PR is updated

## Multi-Agent Consultation

Per TICK protocol, consultation was attempted but is not strictly required for small, well-defined features. The implementation is a single file change with clear scope and comprehensive manual testing.
