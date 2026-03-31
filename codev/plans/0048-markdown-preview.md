# Plan: Markdown Preview for afx open

## Metadata
- **ID**: 0048
- **Status**: draft
- **Specification**: codev/specs/0048-markdown-preview.md
- **Created**: 2025-12-10

## Executive Summary

Implement a toggle button in the `afx open` file viewer that allows users to switch between the default annotated view (line numbers + syntax highlighting) and a rendered markdown preview. The implementation uses marked.js for markdown parsing, DOMPurify for XSS sanitization, and Prism.js (already loaded) for syntax highlighting code blocks.

This is a small, focused change affecting primarily the `open.html` template with minor changes to `open-server.ts`.

## Architecture Clarification

**Important:** The `afx open` UI has three distinct containers:

1. **`#viewMode`** - The default view showing line numbers and syntax-highlighted code in a grid layout. This is what users see when they first open a file.

2. **`#editor`** - A hidden textarea that becomes visible only when the user clicks "Switch to Editing" (the existing edit mode for making changes).

3. **`#preview-container`** (NEW) - The rendered markdown preview that will toggle with `#viewMode`.

The markdown preview feature toggles between `#viewMode` and `#preview-container`. It does NOT interact with `#editor` (the textarea). The "Edit" in the spec's "Edit/Preview toggle" refers to the `#viewMode` annotated view, NOT the textarea edit mode.

**Content source:** The `currentContent` JavaScript variable holds the file content (kept in sync with any edits). Preview rendering reads from `currentContent`, not the textarea.

## Success Metrics
- [ ] All specification criteria met (see spec for full list)
- [ ] Toggle button visible only for `.md` files
- [ ] Preview renders correctly with syntax-highlighted code blocks
- [ ] XSS attacks blocked (verified with security tests)
- [ ] No regressions in existing edit/save functionality
- [ ] Works in both standalone and dashboard tab contexts

## Phase Breakdown

### Phase 1: Server-Side Changes
**Dependencies**: None

#### Objectives
- Pass file type information to the template so it knows when to show the toggle button

#### Deliverables
- [ ] Update `open-server.ts` to pass `isMarkdown` boolean to template
- [ ] Update template placeholders

#### Implementation Details

**File**: `agent-farm/src/servers/open-server.ts`

Add `isMarkdown` detection and template replacement:

```typescript
// After existing lang detection (around line 59-66)
const isMarkdown = ext === 'md';

// In template replacement section (around line 88-91)
template = template.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
```

#### Acceptance Criteria
- [ ] `{{IS_MARKDOWN}}` placeholder replaced with `true` for .md files
- [ ] `{{IS_MARKDOWN}}` placeholder replaced with `false` for other files
- [ ] Existing functionality unchanged

#### Test Plan
- **Manual Testing**: Open .md file, verify `isMarkdown` is true in page source; open .ts file, verify false

#### Rollback Strategy
Revert the single file change to `open-server.ts`

---

### Phase 2: Add CDN Dependencies
**Dependencies**: Phase 1

#### Objectives
- Load marked.js and DOMPurify libraries via CDN (following existing Prism.js pattern)

#### Deliverables
- [ ] Add marked.js CDN script tag
- [ ] Add DOMPurify CDN script tag
- [ ] Conditional loading only for markdown files

#### Implementation Details

**File**: `agent-farm/templates/open.html`

Add to `<head>` section, after Prism.js CDN links:

```html
<!-- Markdown preview dependencies (loaded only for .md files) -->
<script>
  if ({{IS_MARKDOWN}}) {
    document.write('<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"><\/script>');
    document.write('<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"><\/script>');
  }
</script>
```

Note: Using `document.write` for conditional loading keeps it simple. Could also use dynamic script injection, but this matches how simple conditional loading is typically done.

#### Acceptance Criteria
- [ ] marked.js loads for .md files
- [ ] DOMPurify loads for .md files
- [ ] Neither loads for non-.md files (verify in Network tab)

#### Test Plan
- **Manual Testing**: Open .md file, check Network tab for marked.min.js and purify.min.js; open .ts file, verify they don't load

#### Rollback Strategy
Remove the CDN script tags

---

### Phase 3: Toggle Button UI
**Dependencies**: Phase 2

#### Objectives
- Add toggle button to toolbar
- Implement basic show/hide toggling between annotated view and preview container

#### Deliverables
- [ ] Toggle button in toolbar (visible only for .md files)
- [ ] Preview container div
- [ ] Basic toggle functionality (no rendering yet)
- [ ] Keyboard shortcut (Cmd/Ctrl+Shift+P)
- [ ] Disable "Switch to Editing" button when in preview mode

#### Implementation Details

**File**: `agent-farm/templates/open.html`

**HTML structure** (add preview container after `#viewMode`):

```html
<!-- Add after the <div class="content" id="viewMode">...</div> -->
<div id="preview-container" style="display: none; padding: 20px; overflow: auto; height: calc(100vh - 80px);"></div>
```

**Toolbar button** (add after editBtn, before saveBtn):

```html
<button id="togglePreviewBtn" class="btn btn-secondary" style="display: none;" title="Toggle Preview (Cmd+Shift+P)">
  <span id="toggle-icon">👁</span> <span id="toggle-text">Preview</span>
</button>
```

**JavaScript** (toggle logic - add to the script section):

```javascript
// Markdown preview state (add near other state variables like editMode)
const isMarkdown = {{IS_MARKDOWN}};
let isPreviewMode = false;

// DOM elements for preview (add in init or at script start)
const togglePreviewBtn = document.getElementById('togglePreviewBtn');
const previewContainer = document.getElementById('preview-container');
const viewMode = document.getElementById('viewMode');
const editBtn = document.getElementById('editBtn');

// Initialize preview toggle if markdown file
if (isMarkdown && togglePreviewBtn) {
  togglePreviewBtn.style.display = 'inline-block';
  togglePreviewBtn.addEventListener('click', togglePreviewMode);

  // Keyboard shortcut: Cmd/Ctrl+Shift+P
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      togglePreviewMode();
    }
  });
}

function togglePreviewMode() {
  // Don't allow preview toggle while in textarea edit mode
  if (editMode) {
    return;  // Must exit edit mode first
  }

  isPreviewMode = !isPreviewMode;

  const toggleIcon = document.getElementById('toggle-icon');
  const toggleText = document.getElementById('toggle-text');

  if (isPreviewMode) {
    // Switch to Preview mode: hide viewMode, show preview
    viewMode.style.display = 'none';
    previewContainer.style.display = 'block';
    toggleIcon.textContent = '✏️';
    toggleText.textContent = 'Edit';
    editBtn.disabled = true;  // Can't enter edit mode while previewing
    // Note: renderPreview() will be called here in Phase 4
  } else {
    // Switch back to annotated view
    viewMode.style.display = 'grid';  // Restore grid display
    previewContainer.style.display = 'none';
    toggleIcon.textContent = '👁';
    toggleText.textContent = 'Preview';
    editBtn.disabled = false;
  }
}
```

**Important:** The toggle switches between `#viewMode` (the line-number grid) and `#preview-container`. The `#editor` textarea is a separate concept used by the existing "Switch to Editing" functionality.

#### Acceptance Criteria
- [ ] Toggle button visible for .md files
- [ ] Toggle button hidden for non-.md files
- [ ] Clicking toggles between `#viewMode` (annotated view) and empty preview container
- [ ] Cmd/Ctrl+Shift+P triggers toggle
- [ ] "Switch to Editing" button disabled in preview mode (must exit preview first)
- [ ] Toggle does nothing if user is currently in textarea edit mode

#### Test Plan
- **Manual Testing**:
  - Open .md file, verify toggle button visible
  - Open .ts file, verify toggle button hidden
  - Click toggle, verify `#viewMode` (line numbers) hides and preview container shows
  - Press Cmd+Shift+P, verify toggle works
  - Verify "Switch to Editing" button is disabled in preview mode
  - Click "Switch to Editing" first, verify preview toggle button is blocked while in textarea edit mode

#### Rollback Strategy
Remove the toggle button and related JavaScript

---

### Phase 4: Markdown Rendering with Security
**Dependencies**: Phase 3

#### Objectives
- Render markdown content using marked.js
- Sanitize output with DOMPurify
- Configure secure link rendering

#### Deliverables
- [ ] `renderPreview()` function
- [ ] DOMPurify sanitization
- [ ] Secure link renderer (target="_blank" + rel="noopener noreferrer")
- [ ] Preview updates on toggle

#### Implementation Details

**File**: `agent-farm/templates/open.html`

**Configure marked.js with secure link renderer**:

```javascript
// Configure marked.js once on page load (add after isMarkdown check)
if (isMarkdown && typeof marked !== 'undefined') {
  marked.use({
    renderer: {
      link(href, title, text) {
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
    }
  });
}

function renderPreview() {
  // Use currentContent (the authoritative file content variable)
  // This is kept in sync with any edits the user makes
  const rawHtml = marked.parse(currentContent);
  const cleanHtml = DOMPurify.sanitize(rawHtml);
  previewContainer.innerHTML = cleanHtml;
}
```

**Update togglePreviewMode() to call renderPreview()** (in Phase 3 code):

```javascript
function togglePreviewMode() {
  if (editMode) return;

  isPreviewMode = !isPreviewMode;
  // ... (toggle icon/text as before)

  if (isPreviewMode) {
    renderPreview();  // <-- Add this call
    viewMode.style.display = 'none';
    previewContainer.style.display = 'block';
    // ... rest
  } else {
    // ... restore viewMode
  }
}
```

**Note:** The `currentContent` variable is the authoritative source of file content in `open.html`. It's initialized with the file contents and updated whenever the user saves changes. Using this instead of `editor.textContent` ensures preview works even when the user hasn't entered textarea edit mode.

#### Acceptance Criteria
- [ ] Markdown renders as HTML in preview
- [ ] Script tags are stripped (XSS blocked)
- [ ] onerror handlers are stripped (XSS blocked)
- [ ] javascript: URLs are blocked (XSS blocked)
- [ ] Links have target="_blank" rel="noopener noreferrer"

#### Test Plan
- **Security Tests** (Critical):
  - Create test.md with `<script>alert('xss')</script>` - verify no alert
  - Create test.md with `<img onerror="alert('xss')">` - verify no alert
  - Create test.md with `[link](javascript:alert('xss'))` - verify link is sanitized
  - Inspect rendered link elements - verify rel attribute present
- **Manual Testing**:
  - Open spec file, toggle to preview, verify headings/lists render correctly

#### Rollback Strategy
Remove marked.use() configuration and renderPreview() function

---

### Phase 5: Syntax Highlighting in Preview
**Dependencies**: Phase 4

#### Objectives
- Highlight code blocks in preview using Prism.js (already loaded)

#### Deliverables
- [ ] Code blocks have syntax highlighting in preview
- [ ] Language detection works for common languages

#### Implementation Details

**File**: `agent-farm/templates/open.html`

**Update renderPreview() to run Prism.js after markdown rendering**:

```javascript
function renderPreview() {
  // Use currentContent (the authoritative file content variable)
  const rawHtml = marked.parse(currentContent);
  const cleanHtml = DOMPurify.sanitize(rawHtml);
  previewContainer.innerHTML = cleanHtml;

  // Highlight code blocks with Prism.js
  previewContainer.querySelectorAll('pre code').forEach((block) => {
    // Add language class if detected from code fence
    const langMatch = block.className.match(/language-(\w+)/);
    if (langMatch) {
      block.parentElement.classList.add(`language-${langMatch[1]}`);
    }
    Prism.highlightElement(block);
  });
}
```

**Note:** This is an update to the `renderPreview()` function from Phase 4. The syntax highlighting runs after markdown is parsed and sanitized.

#### Acceptance Criteria
- [ ] Code blocks with language specifier (```javascript) are highlighted
- [ ] Code blocks without language specifier render as plain preformatted text
- [ ] Highlighting matches edit mode highlighting style

#### Test Plan
- **Manual Testing**:
  - Open markdown file with JavaScript code block, verify syntax colors in preview
  - Open markdown file with Python code block, verify syntax colors
  - Open markdown file with unlabeled code block, verify it renders but without colors

#### Rollback Strategy
Remove the Prism.js highlighting loop from renderPreview()

---

### Phase 6: Scroll Position & Styling
**Dependencies**: Phase 5

#### Objectives
- Preserve approximate scroll position when toggling
- Apply GitHub-flavored markdown styling

#### Deliverables
- [ ] Scroll position approximately preserved on toggle
- [ ] Preview styled with GFM-like CSS
- [ ] Tables, headings, lists styled appropriately

#### Implementation Details

**File**: `agent-farm/templates/open.html`

**Scroll position handling** (update togglePreviewMode()):

```javascript
function togglePreviewMode() {
  if (editMode) return;

  // Capture scroll position as percentage before switching
  // Note: We scroll the body/document since viewMode/previewContainer fill the viewport
  const scrollPercent = document.documentElement.scrollHeight > 0
    ? window.scrollY / document.documentElement.scrollHeight
    : 0;

  isPreviewMode = !isPreviewMode;

  const toggleIcon = document.getElementById('toggle-icon');
  const toggleText = document.getElementById('toggle-text');

  if (isPreviewMode) {
    renderPreview();
    viewMode.style.display = 'none';
    previewContainer.style.display = 'block';
    toggleIcon.textContent = '✏️';
    toggleText.textContent = 'Edit';
    editBtn.disabled = true;
  } else {
    viewMode.style.display = 'grid';
    previewContainer.style.display = 'none';
    toggleIcon.textContent = '👁';
    toggleText.textContent = 'Preview';
    editBtn.disabled = false;
  }

  // Restore approximate scroll position after content is rendered
  requestAnimationFrame(() => {
    window.scrollTo(0, scrollPercent * document.documentElement.scrollHeight);
  });
}
```

**Note:** Scroll position is tracked on the window/document level since both `#viewMode` and `#preview-container` fill the viewport. This provides approximate scroll preservation when toggling between modes.

**CSS styling** (add to `<style>` section):

Note: Since `open.html` uses hardcoded colors (not CSS variables), use explicit color values matching the existing dark theme:

```css
#preview-container {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
  color: #fff;  /* Match body color */
  max-width: 900px;
  margin: 0 auto;
}

#preview-container h1,
#preview-container h2 {
  border-bottom: 1px solid #333;  /* Match existing border colors */
  padding-bottom: 0.3em;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

#preview-container h1 { font-size: 2em; }
#preview-container h2 { font-size: 1.5em; }
#preview-container h3 { font-size: 1.25em; margin-top: 1em; }

#preview-container code {
  background: #2c313a;  /* Match .md-code background */
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-size: 0.9em;
}

#preview-container pre {
  background: #252525;  /* Match .line-num background */
  padding: 16px;
  overflow: auto;
  border-radius: 6px;
  margin: 1em 0;
}

#preview-container pre code {
  background: none;
  padding: 0;
}

#preview-container table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}

#preview-container th,
#preview-container td {
  border: 1px solid #333;
  padding: 8px 12px;
  text-align: left;
}

#preview-container th {
  background: #2a2a2a;  /* Match .header background */
}

#preview-container tr:nth-child(even) {
  background: #252525;
}

#preview-container a {
  color: #3b82f6;  /* Match .btn-primary */
  text-decoration: underline;
}

#preview-container ul,
#preview-container ol {
  padding-left: 2em;
  margin: 1em 0;
}

#preview-container blockquote {
  border-left: 4px solid #333;
  padding-left: 1em;
  margin: 1em 0;
  color: #888;  /* Match .subtitle color */
}
```

#### Acceptance Criteria
- [ ] Scroll position approximately maintained when toggling
- [ ] Headings have proper sizing and border
- [ ] Code blocks have gray background
- [ ] Tables have borders and alternating row colors
- [ ] Links are blue and underlined
- [ ] Lists are properly indented

#### Test Plan
- **Manual Testing**:
  - Scroll to middle of long markdown file, toggle to preview, verify position is approximate
  - Toggle back to edit, verify position is approximate
  - Verify all styling elements look reasonable

#### Rollback Strategy
Remove CSS and scroll position code

---

### Phase 7: Testing & Polish
**Dependencies**: Phase 6

#### Objectives
- Comprehensive testing of all scenarios
- Fix any bugs found
- Edge case handling

#### Deliverables
- [ ] All functional tests pass
- [ ] All security tests pass
- [ ] Edge cases handled gracefully

#### Test Plan

**Functional Tests**:
1. Open .md file → toggle button visible
2. Open .ts file → toggle button NOT visible
3. Click toggle → switches to Preview mode with rendered markdown
4. Click toggle again → switches back to Edit mode
5. Edit content in Edit mode → switch to Preview → see updated content
6. Preview mode → cannot edit content
7. Save button disabled in Preview mode
8. Save works in Edit mode
9. Cmd/Ctrl+Shift+P toggles between modes
10. Works in dashboard tab context

**Security Tests**:
1. `<script>alert('xss')</script>` → script NOT executed
2. `<img onerror="alert('xss')">` → handler NOT executed
3. `[link](javascript:alert('xss'))` → link sanitized/blocked
4. `<iframe src="evil.com">` → iframe removed
5. Links have `rel="noopener noreferrer"` (inspect DOM)

**Edge Cases**:
1. Large markdown file (>1000 lines) renders without freezing
2. Empty markdown file shows empty preview
3. Malformed markdown degrades gracefully

#### Rollback Strategy
N/A - this phase is testing only

---

## Dependency Map
```
Phase 1 (Server) ──→ Phase 2 (CDN) ──→ Phase 3 (Toggle UI) ──→ Phase 4 (Rendering)
                                                                    ↓
                                       Phase 7 (Testing) ←── Phase 6 (Styling) ←── Phase 5 (Highlighting)
```

## Resource Requirements

### Development Resources
- **Engineers**: 1 (familiar with TypeScript, HTML/CSS/JS)
- **Environment**: Local development with `afx start`

### Infrastructure
- No database changes
- No new services
- CDN dependencies: jsdelivr.net (marked.js, DOMPurify)

## Integration Points

### External Systems
- **jsdelivr CDN**: For marked.js and DOMPurify
  - **Fallback**: If CDN unavailable, toggle button hidden (feature gracefully degrades)

### Internal Systems
- **open-server.ts**: Minor change to pass `isMarkdown` flag
- **open.html**: Main implementation work

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| XSS vulnerability | Low | High | DOMPurify + security tests | Builder |
| CDN unavailable | Low | Medium | Graceful degradation | Builder |
| Performance on large files | Low | Low | Test with 1000+ line files | Builder |

## Validation Checkpoints
1. **After Phase 3**: Toggle button works (no rendering yet)
2. **After Phase 4**: Security tests pass (XSS blocked)
3. **After Phase 6**: All styling applied, scroll works
4. **Before PR**: All Phase 7 tests pass

## Documentation Updates Required
- [ ] CLI command reference (if any behavioral changes documented)

## Post-Implementation Tasks
- [ ] Manual testing in dashboard context
- [ ] Security verification (run XSS test cases)
- [ ] Performance spot check with large markdown file

## Expert Review

### 3-Way Plan Review (2025-12-10)

| Model | Verdict | Summary |
|-------|---------|---------|
| Gemini | ✅ APPROVE | Detailed and well-structured plan with appropriate risk mitigations |
| Codex | ⚠️ REQUEST_CHANGES | Plan targeted wrong UI elements; needed architectural clarification |
| Claude | ✅ APPROVE | Well-structured with minor cleanup needed |

**Codex's Key Issues (ADDRESSED):**
1. ~~Preview wired to `#editor` instead of `#viewMode`~~ → Fixed: Added Architecture Clarification section, updated all phases
2. ~~Content reads from editor textarea~~ → Fixed: Now uses `currentContent` variable
3. ~~Scroll preservation on wrong elements~~ → Fixed: Now uses window scroll position
4. ~~Save button/edit mode interaction unclear~~ → Fixed: editBtn disabled in preview mode

**Claude's Minor Issues (ADDRESSED):**
1. ~~`updateToggleButton()` undefined~~ → Removed from Phase 6
2. ~~CSS variables need verification~~ → Replaced with hardcoded colors matching theme

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2025-12-10 | Initial plan | Created from spec | Architect |
| 2025-12-10 | Major revision | Address 3-way review feedback (Codex: architectural issues, Claude: minor cleanup) | Architect |

## Notes
- Implementation details moved from spec per architect review
- Images won't render (known server limitation, out of scope)
- Could extend to HTML/SVG preview in future
