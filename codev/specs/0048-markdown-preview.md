# Specification: Markdown Preview for afx open

## Metadata
- **ID**: 0048
- **Status**: draft
- **Created**: 2025-12-10

## Problem Statement

When using `afx open` to view markdown files (specs, plans, reviews, documentation), the content is displayed as raw text with syntax highlighting. While this is useful for editing, it makes it harder to read and review the document's actual rendered content - headings, lists, code blocks, tables, and links are not visually distinguished.

Architects and reviewers frequently need to read markdown documents to understand specifications and plans. The current raw view requires mental parsing of markdown syntax, reducing readability and review efficiency.

## Current State

The `afx open` command:
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
- **Secondary Users**: Anyone using `afx open` on markdown files
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Toggle button appears only for `.md` files
- [ ] Preview mode renders markdown with proper formatting (headings, lists, code, tables, links)
- [ ] Code blocks in preview have syntax highlighting via Prism.js
- [ ] Edit mode retains current functionality (raw text, line numbers, editable)
- [ ] Toggle state persists in-memory during page session (per-tab, not across page reloads)
- [ ] Approximate scroll position preserved when toggling (best effort, not pixel-perfect)
- [ ] Preview updates when switching from Edit after changes
- [ ] Works in both standalone mode and dashboard tab mode
- [ ] Save button disabled/hidden in Preview mode
- [ ] XSS attacks blocked (verified via adversarial markdown test)

## Constraints

### Technical Constraints
- Must work client-side (no server-side markdown rendering)
- Should use a lightweight markdown library (bundle size matters)
- Must integrate with existing open.html template
- Dashboard file tabs use same template - changes affect both contexts

### Business Constraints
- Should be a small, focused change
- Follow existing CDN pattern (like Prism.js) for loading marked.js and DOMPurify

## Assumptions
- marked.js + DOMPurify is acceptable for markdown rendering and sanitization
- Users will primarily use Preview for reading, Edit for modifications
- Default mode is Edit (preserves current behavior)
- Images in markdown are not expected to render (server doesn't serve static assets from file directories - this is a known limitation, not a blocker for this spec)

## Solution Approaches

### Approach 1: Toggle Button with marked.js + DOMPurify (Recommended)

**Description**: Add a toggle button that switches between raw editor and rendered preview using marked.js for parsing and DOMPurify for XSS sanitization.

**Implementation**:
1. Add marked.js + DOMPurify via CDN (following existing Prism.js pattern)
2. Add toggle button to toolbar (visible only for .md files)
3. Create preview container alongside editor
4. Toggle visibility between editor and preview
5. Re-render preview when switching from Edit mode
6. Run `Prism.highlightAll()` after rendering to highlight code blocks
7. Disable/hide save button in Preview mode

**Pros**:
- Simple implementation
- marked.js is well-maintained and fast
- DOMPurify is the standard for HTML sanitization
- Clean separation between modes
- Minimal changes to existing code

**Cons**:
- Adds ~28KB marked.js (gzipped ~9KB) + ~15KB DOMPurify (gzipped ~6KB) to page load for .md files
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

**Approach 1: Toggle Button with marked.js + DOMPurify** - simplest solution that fully addresses the need.

## Open Questions

### Critical (Blocks Progress)
- [x] Should Preview be the default mode for .md files? **Decision: No, keep Edit as default to preserve current behavior. Users can toggle to Preview.**

### Important (Affects Design)
- [x] Should the toggle be a button or tabs? **Decision: Simple toggle button with icon (eye for preview, pencil for edit)**
- [x] How to handle syntax highlighting in preview? **Decision: Call `Prism.highlightAll()` after marked.js renders HTML**
- [x] How to handle scroll position? **Decision: Best-effort approximate position via percentage-based scroll mapping**
- [x] Save button behavior in Preview mode? **Decision: Disable the save button (grayed out) to indicate read-only state**

### Nice-to-Know (Optimization)
- [x] Should we add a keyboard shortcut for toggling? **Decision: Yes, Cmd/Ctrl+Shift+P to toggle preview**

## Performance Requirements
- **Page Load**: Adding libraries should not noticeably delay page load (lazy-load only for .md files)
- **Render Time**: Preview should render in <200ms for typical spec files (<500 lines)
- **Large Files**: Files >1000 lines may show loading indicator; render should complete within 500ms

## Security Considerations

### XSS Prevention (Critical)
- **DO NOT** use marked.js `sanitize` option (deprecated since v0.7.0, removed in v5.0)
- **MUST** use DOMPurify to sanitize all HTML output from marked.js:
  ```javascript
  const rawHtml = marked.parse(markdownContent);
  const cleanHtml = DOMPurify.sanitize(rawHtml);
  previewContainer.innerHTML = cleanHtml;
  ```

### Link Security
- All links in preview must have `target="_blank"` AND `rel="noopener noreferrer"`:
  ```javascript
  marked.use({
    renderer: {
      link(href, title, text) {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
    }
  });
  ```

### Content Security Policy
- No changes to CSP required - CDN scripts follow existing Prism.js pattern
- DOMPurify removes inline event handlers and javascript: URLs by default

## Test Scenarios

### Functional Tests
1. Open .md file → toggle button visible
2. Open .ts file → toggle button NOT visible
3. Click toggle → switches to Preview mode with rendered markdown
4. Click toggle again → switches back to Edit mode
5. Edit content in Edit mode → switch to Preview → see updated content
6. Preview mode → cannot edit content (text not selectable for editing)
7. Save button disabled in Preview mode
8. Save works in Edit mode (existing functionality preserved)
9. Cmd/Ctrl+Shift+P toggles between modes
10. Works in dashboard tab context (same behavior)

### Security Tests (Critical)
1. Markdown with `<script>alert('xss')</script>` → script NOT executed
2. Markdown with `<img onerror="alert('xss')">` → handler NOT executed
3. Markdown with `[link](javascript:alert('xss'))` → link sanitized/blocked
4. Markdown with `<iframe src="evil.com">` → iframe removed
5. Links open with `rel="noopener noreferrer"` (inspect DOM)

### Edge Cases
1. Large markdown file (>1000 lines) renders without freezing browser
2. Markdown with code blocks renders with syntax highlighting (verify Prism.js runs)
3. Markdown with tables renders correctly
4. Markdown with images shows broken image placeholder (expected - server doesn't serve assets)
5. Invalid/malformed markdown degrades gracefully (shows partial render, no crash)
6. Empty markdown file shows empty preview (no error)
7. Switching tabs in dashboard maintains separate toggle states per tab

## Dependencies
- **External Libraries**:
  - marked.js (CDN: cdnjs or unpkg)
  - DOMPurify (CDN: cdnjs or unpkg)
- **Internal Systems**:
  - open-server.ts (may need to pass `isMarkdown` flag)
  - open.html template

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| XSS via malicious markdown | Low | High | DOMPurify sanitization (mandatory) |
| marked.js/DOMPurify CDN unavailable | Low | Medium | Feature gracefully degrades (toggle hidden) |
| Performance on large files | Low | Medium | Loading indicator, tested with 1000+ line files |
| Scroll position mismatch | Medium | Low | Best-effort percentage mapping, documented as approximate |

## Expert Consultation

**Date**: 2025-12-10
**Models Consulted**: Claude, Gemini, Codex (3-way parallel review)

### Key Feedback Incorporated:

**Security (All 3 reviewers)**:
- Updated to explicitly require DOMPurify (marked.js `sanitize` is deprecated)
- Added `rel="noopener noreferrer"` requirement for links
- Added security test scenarios for XSS vectors

**Syntax Highlighting (Claude, Codex)**:
- Added explicit requirement to call `Prism.highlightAll()` after rendering
- Added implementation code example

**CDN Constraint Clarification (Claude, Codex)**:
- Clarified constraint: "Follow existing CDN pattern" (not "no CDN")
- Added DOMPurify to dependencies

**Toggle Behavior (Codex)**:
- Clarified: toggle state is in-memory, per-tab, not persisted across reloads
- Added keyboard shortcut decision (Cmd/Ctrl+Shift+P)

**Asset Serving (Gemini)**:
- Added assumption: images won't render (known limitation, not a blocker)
- Added edge case test for broken image placeholder

**Save Button (Gemini)**:
- Added requirement: Save button disabled in Preview mode
- Added to success criteria and test scenarios

**Scroll Position (Gemini)**:
- Softened requirement to "approximate" scroll position
- Added implementation approach using percentage-based mapping

**Performance (Codex)**:
- Adjusted render time target to 200ms (more realistic)
- Added 500ms target for large files with loading indicator option

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [x] Expert AI Consultation Complete

## Notes
- Images in markdown won't render (server limitation) - could be addressed in future spec
- Could extend to other previewable formats (HTML, SVG) later
- Preview styling follows GitHub-flavored markdown for familiarity
