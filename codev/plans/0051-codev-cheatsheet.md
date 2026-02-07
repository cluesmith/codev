# Plan 0051: Codev Cheatsheet

**Spec:** codev/specs/0051-codev-cheatsheet.md
**Status:** planned

---

## Implementation Steps

### Step 1: Create Cheatsheet

Create `codev/resources/cheatsheet.md` with the following structure:

```markdown
# Codev Cheatsheet

## Core Philosophies

### 1. Natural Language is the Programming Language
[Explain philosophy + corollaries]

### 2. Multiple Models Outperform a Single Model
[Explain philosophy + corollaries]

### 3. Human-Agent Work Requires Thoughtful Structure
[Explain philosophy + corollaries]

## Core Concepts

### Protocols
- **SPIR**: ...
- **TICK**: ...
- **MAINTAIN**: ...
- **EXPERIMENT**: ...

### Roles
- **Architect**: ...
- **Builder**: ...
- **Consultant**: ...

### Information Hierarchy
[ASCII diagram]

## Tools Reference

### codev
[Commands table]

### agent-farm (af)
[Commands table]

### consult
[Commands table with parameters]
```

### Step 2: Update CLAUDE.md

Add link to cheatsheet in the Quick Start section:

```markdown
## Quick Start

> **New to Codev?** See the [Cheatsheet](codev/resources/cheatsheet.md) for philosophies, concepts, and tool reference.
```

### Step 3: Update README.md

Add link in documentation section:

```markdown
## Documentation

- [Cheatsheet](codev/resources/cheatsheet.md) - Quick reference for philosophies, concepts, and tools
```

### Step 4: Update AGENTS.md

Keep in sync with CLAUDE.md (same link added).

---

## File Changes

| File | Action |
|------|--------|
| `codev/resources/cheatsheet.md` | Create |
| `CLAUDE.md` | Add link |
| `AGENTS.md` | Add link |
| `README.md` | Add link |

---

## Testing

- [ ] Cheatsheet renders correctly in markdown viewers
- [ ] All links from CLAUDE.md, AGENTS.md, README.md resolve
- [ ] Information is accurate and matches current implementation
