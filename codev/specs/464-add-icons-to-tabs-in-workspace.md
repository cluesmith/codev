# Specification: Add Icons to Tabs in Workspace Overview

## Metadata
- **ID**: spec-2026-02-21-add-icons-to-tabs
- **Status**: draft
- **Created**: 2026-02-21
- **Issue**: #464

## Problem Statement

The workspace dashboard tab bar displays text-only labels for all tabs (Work, Architect, Builder, Shell, File). Without visual differentiation, users must read each label to identify tab types, which slows navigation — especially when multiple builder and shell tabs are open and labels get truncated by the 120px max-width.

## Current State

The tab bar renders tabs with text labels only:
- **Work** — always present, shows overview of builders/projects
- **Architect** — the architect terminal session
- **Builder** (dynamic, one per builder) — labeled with builder name or ID
- **Shell** (dynamic, user-created) — labeled "Shell {id}" or custom name
- **File** (dynamic) — labeled with filename from annotation viewer

Each tab is a `<button>` containing `<span className="tab-label">{tab.label}</span>` and an optional close button. There is no icon support in the `Tab` interface or rendering.

The `FileTree` component already uses emoji for file icons (📂, 📁, 📄, 🕐), establishing a precedent for emoji-based iconography in the dashboard.

## Desired State

Each tab displays a compact icon before its text label for instant visual identification:

| Tab Type | Icon | Unicode | Rationale |
|----------|------|---------|-----------|
| Work | `◈` | U+25C8 | Dashboard/overview — distinctive geometric shape |
| Architect | `▶︎` | U+25B6 + U+FE0E | Terminal prompt arrow — text presentation forced |
| Builder | `⚒︎` | U+2692 + U+FE0E | Hammer and pick — text presentation forced |
| Shell | `$` | U+0024 | Universal shell prompt symbol — most recognizable |
| File | `≡` | U+2261 | Document/lines icon — compact file representation |
| Activity | `⚡` | U+26A1 + U+FE0E | Activity/events — unused now, for future use |
| Files | `☰` | U+2630 | File browser — unused now, for future use |

**Emoji presentation**: Characters that have both text and emoji forms (▶, ⚒, ⚡) must use the **text presentation selector** (U+FE0E) to force monochrome rendering. This prevents macOS/Windows from rendering them as color emoji, which would be inconsistent with the terminal-aesthetic UI.

Icons are rendered as inline text characters (Unicode symbols) for:
- Zero dependency footprint (no icon library, no SVGs, no font files)
- Consistent rendering in the monospace terminal-adjacent UI
- Easy maintenance — just a character in a map

**Accessibility**: Icon spans must have `aria-hidden="true"` since they are purely decorative — the text label already conveys the tab's purpose. This prevents screen readers from announcing meaningless symbol names.

**CSS**: The `.tab` button already uses `display: flex; gap: 6px;`, so a new `.tab-icon` span placed before `.tab-label` will get proper spacing automatically. The `.tab-icon` span must use `flex-shrink: 0` to prevent the icon from being squeezed when the label truncates.

**Note on issue vs. actual tabs**: The issue references "Specs" and "Plans" tabs, but these don't exist as separate tabs. Specs and plans are sections within the Work tab. The actual tab types are listed above.

## Stakeholders
- **Primary Users**: Developers using the Codev dashboard
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Every tab type displays an icon before its label
- [ ] Icons are visually distinct at the default 12px tab font size
- [ ] Icons render correctly in Chrome, Firefox, and Safari
- [ ] Tab height (34px) is unchanged
- [ ] Truncated labels still show their icon
- [ ] No new dependencies added
- [ ] Existing tab close button behavior is unaffected

## Constraints

### Technical Constraints
- Must work within the existing 34px tab height
- Must not increase bundle size (no icon libraries)
- Must be consistent with the dashboard's dark theme
- Tab labels have a 120px max-width — icons must not consume excessive space

## Assumptions
- Unicode symbols with text presentation selectors render adequately across modern browsers on macOS, Windows, and Linux
- The `Tab` interface in `useTabs.ts` can be extended without breaking consumers
- The icon map should be a complete `Record<Tab['type'], string>` covering all types in the union, including unused ones, for type safety

## Solution Approaches

### Approach 1: Unicode Symbol Map (Recommended)
**Description**: Add a static `TAB_ICONS` map from tab type to Unicode character. Render the icon as a `<span className="tab-icon">` before the label.

**Pros**:
- Zero dependencies
- Trivial to add, change, or remove icons
- Consistent with the text-heavy terminal UI aesthetic
- Works at any font size

**Cons**:
- Unicode rendering varies slightly across platforms (though modern browsers are consistent)
- Limited visual richness compared to SVG

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Inline SVG Components
**Description**: Create small React SVG icon components for each tab type.

**Pros**:
- Pixel-perfect rendering across all platforms
- Full control over size, color, and styling

**Cons**:
- More code to maintain (5 SVG components)
- Heavier change for a cosmetic feature
- Needs careful sizing to fit 34px tabs

**Estimated Complexity**: Medium
**Risk Level**: Low

### Recommended: Approach 1 (Unicode Symbol Map)
The dashboard already uses emoji in FileTree. Unicode symbols are simpler, lighter, and fit the terminal-aesthetic UI. If cross-platform rendering issues arise, individual icons can be swapped to SVG later without changing the architecture.

## Open Questions

### Important (Affects Design)
- [x] Should the icon replace the label at narrow widths, or always appear alongside? → Always alongside; CSS truncation on the label handles narrow tabs.

## Test Scenarios

### Functional Tests
1. Each tab type renders with the correct icon character
2. Icon appears before the label text
3. Close button still functions on closable tabs
4. Tab selection (click, keyboard) still works with icons present

### Visual Tests
1. Icons are visible at default (12px) and small (11px mobile) font sizes
2. Icons don't cause tab height to change from 34px
3. Long labels truncate with ellipsis, icon remains visible

## Dependencies
- None — pure UI change within existing dashboard components

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Unicode symbol not rendering on some platform | Low | Low | Use widely-supported symbols with U+FE0E; can swap individual icons to SVG |
| Icon renders as color emoji instead of monochrome | Low | Medium | Apply U+FE0E text presentation selector to all dual-mode characters |
| Icon crowds the label in narrow tabs | Low | Low | Icon span uses flex-shrink: 0; label truncation handles overflow |

## Expert Consultation
**Date**: 2026-02-21
**Models Consulted**: Gemini, Codex, Claude
**Sections Updated**:
- Desired State: Added U+FE0E text presentation selectors, icons for unused `activity`/`files` types, accessibility guidance, and CSS flex-shrink note
- Assumptions: Added type-safe Record requirement for icon map
- Risks: Added color emoji rendering risk with mitigation
