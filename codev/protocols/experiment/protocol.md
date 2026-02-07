# EXPERIMENT Protocol

## Overview

Disciplined experimentation: Each experiment gets its own directory with `notes.md` tracking goals, code, and results.

**Core Principle**: Document what you're trying, what you did, and what you learned.

## When to Use

**Use for**: Testing approaches, evaluating models, prototyping, proof-of-concept work, research spikes

**Skip for**: Production code (use SPIR), simple one-off scripts, well-understood implementations (use TICK)

## Structure

```
experiments/
├── 0001_descriptive_name/
│   ├── notes.md           # Goal, code, results
│   ├── experiment.py      # Your experiment code
│   └── data/
│       ├── input/         # Input data
│       └── output/        # Results, plots, etc.
└── 0002_another_experiment/
    ├── notes.md
    └── ...
```

## Workflow

### 1. Create Experiment Directory

```bash
# Create numbered directory
mkdir -p experiments/0001_experiment_name
cd experiments/0001_experiment_name

# Initialize notes.md from template
cp codev/protocols/experiment/templates/notes.md notes.md
```

Or ask your AI assistant: "Create a new experiment for [goal]"

### 2. Document the Goal

Before writing code, clearly state what you're trying to learn in `notes.md`:

```markdown
## Goal

What specific question are you trying to answer?
What hypothesis are you testing?
```

### 3. Write Experiment Code

- Keep it simple - experiments don't need production polish
- Reuse existing project modules where possible
- Any structure is fine - focus on learning, not architecture

**Dependencies**: If your experiment requires libraries not in the main project:
1. Do NOT add them to the main project's `requirements.txt` or `pyproject.toml`
2. Create a `requirements.txt` inside your experiment folder
3. Document installation in `notes.md`

### 4. Run and Observe

Execute your experiment and capture results:
- Save output files to `data/output/`
- Take screenshots of visualizations
- Log key metrics

### 5. Document Results

Update `notes.md` with:
- What happened (actual results)
- What you learned (insights)
- What's next (follow-up actions)

### 6. Commit

```bash
git add experiments/0001_experiment_name/
git commit -m "[Experiment 0001] Brief description of findings"
```

## notes.md Template

See `templates/notes.md` for the full template. Key sections:

```markdown
# Experiment ####: Name

**Status**: In Progress | Complete | Disproved | Aborted

**Date**: YYYY-MM-DD

## Goal
What are you trying to learn?

## Time Investment
Wall clock time vs active developer time

## Code
- [experiment.py](experiment.py) - Brief description

## Results
What happened? What did you learn?

## Next Steps
What should be done based on findings?
```

## Best Practices

### Keep It Simple
- Experiments don't need production polish
- Skip comprehensive error handling
- Focus on answering the question

### Document Honestly
- Include failures - they're valuable learnings
- Note dead ends and why they didn't work
- Be specific about what surprised you

### Track Time Investment
- Wall clock time: Total elapsed time
- Developer time: Active working time (excluding waiting)
- Helps estimate future similar work

### Use Project Modules
- Don't duplicate existing code
- Import from your `src/` directory
- Experiments validate approaches, not reimplement them

### Commit Progress
- Use `[Experiment ####]` commit prefix
- Commit intermediate results
- Include output files when reasonable

## Integration with Other Protocols

### Experiment → SPIR
When an experiment validates an approach for production use:

1. Create a specification referencing the experiment
2. Link to experiment results as evidence
3. Use experiment code as reference implementation

Example spec reference:
```markdown
## Background

Experiment 0005 validated that [approach] achieves [results].
See: experiments/0005_validation_test/notes.md
```

### Experiment → TICK
For small, validated changes discovered during experimentation:
- Use TICK for quick implementation
- Reference experiment as justification

## Numbering Convention

Use four-digit sequential numbering (consistent with project list):
- `0001_`, `0002_`, `0003_`...
- Shared sequence across all experiments
- Descriptive name after the number (snake_case)

Examples:
- `0001_api_response_caching`
- `0002_model_comparison`
- `0003_performance_baseline`

## Git Workflow

### Commits
```
[Experiment 0001] Initial setup and goal
[Experiment 0001] Add baseline measurements
[Experiment 0001] Complete - caching improves latency 40%
```

### When to Commit
- After setting up the experiment
- After significant findings
- When completing the experiment

**Data Management**:
- Include `data/output/` ONLY if files are small (summary metrics, small plots)
- Do NOT commit large datasets, binary model checkpoints, or heavy artifacts
- Add appropriate entries to `.gitignore` for large files
- Consider storing large outputs externally and linking in notes

## Example Experiment

```
experiments/0001_caching_strategy/
├── notes.md
├── benchmark.py
├── cache_test.py
└── data/
    ├── input/
    │   └── sample_requests.json
    └── output/
        ├── results.csv
        └── latency_chart.png
```

**notes.md excerpt:**
```markdown
# Experiment 0001: Caching Strategy Evaluation

**Status**: Complete

**Date**: 2024-01-15

## Goal
Determine if Redis caching improves API response times for repeated queries.

## Results
- 40% latency reduction for cached queries
- Cache hit rate: 73% after warm-up
- Memory usage: 50MB for 10k cached responses

## Next Steps
Create SPIR spec for production caching implementation.
```
