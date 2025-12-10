# Specification: Markdown Preview for af open

## Metadata
- **ID**: 0048
- **Status**: draft
- **Created**: 2025-12-10

## Problem Statement

When using `af open` to view markdown files (specs, plans, reviews, documentation), the content is displayed as raw text with syntax highlighting. While this is useful for editing, it makes it harder to read and review the document's actual rendered content - headings, lists, code blocks, tables, and links are not visually distinguished.

Architects and reviewers frequently need to read markdown documents to understand specifications and plans. The current raw view requires mental parsing of markdown syntax, reducing readability and review efficiency.

## Current State

The `af open` command:
1. Opens files in a browser-based editor with Prism.js syntax highlighting
2. Treats markdown files the same as any other text file
3. Shows line numbers and raw markdown syntax
4. Supports editing and saving

The viewer is implemented in:
- `agent-farm/src/commands/open.ts` - CLI command
- `agent-farm/src/servers/open-server.ts` - HTTP server
- `agent-farm/templates/open.html` - HTML template with Prism.js

## Desired State

Add a **preview toggle** for markdown files that:
1. Renders markdown as formatted HTML (headings, lists, code blocks, tables, links)
2. Toggles between "Edit" (raw) and "Preview" (rendered) modes
3. Only appears for `.md` files
4. Preserves existing edit/save functionality in Edit mode
5. Preview mode is read-only (no editing)

## Stakeholders
- **Primary Users**: Architects reviewing specs/plans, builders reading documentation
- **Secondary Users**: Anyone using `af open` on markdown files
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Toggle button appears only for `.md` files
- [ ] Preview mode renders markdown with proper formatting (headings, lists, code, tables, links)
- [ ] Code blocks in preview have syntax highlighting
- [ ] Edit mode retains current functionality (raw text, line numbers, editable)
- [ ] Toggle state persists during session (switching back shows same scroll position)
- [ ] Preview updates when switching from Edit after changes
- [ ] Works in both standalone mode and dashboard tab mode

## Constraints

### Technical Constraints
- Must work client-side (no server-side markdown rendering)
- Should use a lightweight markdown library (bundle size matters)
- Must integrate with existing open.html template
- Dashboard file tabs use same template - changes affect both contexts

### Business Constraints
- Should be a small, focused change
- No external CDN dependencies (bundle library or use existing CDN pattern)

## Assumptions
- marked.js or similar library is acceptable for markdown rendering
- Users will primarily use Preview for reading, Edit for modifications
- Default mode can be Edit (preserves current behavior)

## Solution Approaches

### Approach 1: Toggle Button with marked.js (Recommended)

**Description**: Add a toggle button that switches between raw editor and rendered preview using marked.js for parsing.

**Implementation**:
1. Add marked.js via CDN (like existing Prism.js)
2. Add toggle button to toolbar (visible only for .md files)
3. Create preview container alongside editor
4. Toggle visibility between editor and preview
5. Re-render preview when switching from Edit mode

**Pros**:
- Simple implementation
- marked.js is well-maintained and fast
- Clean separation between modes
- Minimal changes to existing code

**Cons**:
- Adds ~28KB (gzipped ~9KB) to page load for .md files
- Two separate DOM elements (editor + preview)

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Inline Preview with Contenteditable

**Description**: Replace the editor with a contenteditable div that shows rendered markdown but allows editing.

**Pros**:
- Single element, no toggle needed
- WYSIWYG-like experience

**Cons**:
- Complex to implement correctly
- Markdown source would be lost (user edits rendered HTML)
- Much higher risk of bugs
- Not really what users want (they want to see rendered AND edit source)

**Estimated Complexity**: High
**Risk Level**: High

### Approach 3: Split View

**Description**: Show editor and preview side-by-side simultaneously.

**Pros**:
- See both views at once
- Live preview while editing

**Cons**:
- More complex layout
- Takes more screen space
- May not work well in dashboard tabs (limited width)
- Overkill for the use case (mostly reading, not editing)

**Estimated Complexity**: Medium
**Risk Level**: Medium

## Selected Approach

**Approach 1: Toggle Button with marked.js** - simplest solution that fully addresses the need.

## Open Questions

### Critical (Blocks Progress)
- [x] Should Preview be the default mode for .md files? **Decision: No, keep Edit as default to preserve current behavior. Users can toggle to Preview.**

### Important (Affects Design)
- [x] Should the toggle be a button or tabs? **Decision: Simple toggle button with icon (eye for preview, pencil for edit)**

### Nice-to-Know (Optimization)
- [ ] Should we add a keyboard shortcut for toggling? (e.g., Cmd+Shift+P)

## Performance Requirements
- **Page Load**: Adding marked.js should not noticeably delay page load
- **Render Time**: Preview should render in <100ms for typical spec files (<500 lines)

## Security Considerations
- marked.js output must be sanitized to prevent XSS from malicious markdown
- Use marked.js with `sanitize: true` or DOMPurify for HTML output
- Links in preview should open in new tab (`target="_blank"`)

## Test Scenarios

### Functional Tests
1. Open .md file → toggle button visible
2. Open .ts file → toggle button NOT visible
3. Click toggle → switches to Preview mode with rendered markdown
4. Click toggle again → switches back to Edit mode
5. Edit content in Edit mode → switch to Preview → see updated content
6. Preview mode → cannot edit content
7. Save works in Edit mode (existing functionality preserved)

### Edge Cases
1. Large markdown file (>1000 lines) renders without freezing
2. Markdown with code blocks renders with syntax highlighting
3. Markdown with tables renders correctly
4. Markdown with images shows image (if path is valid)
5. Invalid markdown degrades gracefully

## Dependencies
- **External Libraries**: marked.js (CDN)
- **Internal Systems**: open-server.ts, open.html template

## Implementation Notes

### Files to Modify
1. `agent-farm/templates/open.html` - Add toggle UI, marked.js, preview container
2. Possibly `agent-farm/src/servers/open-server.ts` - Pass file extension to template

### UI Design
```
┌─────────────────────────────────────────────┐
│ [filename.md]              [👁 Preview] [💾] │  <- Toggle button added
├─────────────────────────────────────────────┤
│                                             │
│  # Heading                                  │  <- Preview mode (rendered)
│                                             │
│  This is a paragraph with **bold** text.   │
│                                             │
│  - List item 1                              │
│  - List item 2                              │
│                                             │
│  ```javascript                              │
│  const x = 1;                               │
│  ```                                        │
│                                             │
└─────────────────────────────────────────────┘
```

Toggle button changes icon:
- Preview mode: 👁 (eye icon) - "Viewing rendered"
- Edit mode: ✏️ (pencil icon) - "Editing source"

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| XSS via malicious markdown | Low | High | Use marked.js sanitization + DOMPurify |
| marked.js CDN unavailable | Low | Medium | Could bundle locally as fallback |
| Performance on large files | Low | Low | Lazy render, test with large files |

## Expert Consultation
<!-- To be filled after 3-way review -->

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Expert AI Consultation Complete

## Notes
- Consider adding keyboard shortcut (Cmd+Shift+P) in future iteration
- Could extend to other previewable formats (HTML, SVG) later
