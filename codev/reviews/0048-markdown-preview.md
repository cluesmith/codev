# Review: Markdown Preview for af open

## Metadata
- **ID**: 0048
- **Status**: implemented
- **Specification**: codev/specs/0048-markdown-preview.md
- **Plan**: codev/plans/0048-markdown-preview.md
- **Implementation Date**: 2025-12-10

## Summary

This review documents the implementation of markdown preview functionality for the `af open` command. The feature adds a toggle button that allows users to switch between the annotated line-by-line view and a rendered markdown preview for `.md` files.

## Implementation Overview

### Files Changed
1. **`agent-farm/src/servers/open-server.ts`** (+2 lines)
   - Added `isMarkdown` constant based on file extension
   - Added template placeholder replacement for `{{IS_MARKDOWN}}`

2. **`agent-farm/templates/open.html`** (+202 lines)
   - Conditional CDN loading for marked.js and DOMPurify
   - Preview container with GitHub-flavored markdown styling
   - Toggle button with eye/pencil icons
   - Toggle logic with scroll position preservation
   - Security configurations for marked.js link renderer
   - Keyboard shortcut (Cmd/Ctrl+Shift+P)

### Key Decisions
1. **DOMPurify for XSS protection**: Used instead of deprecated marked.js sanitize option
2. **CDN loading**: Conditional via `document.write` to avoid loading for non-markdown files
3. **Three-container architecture**: viewMode (annotated), editor (textarea), preview-container
4. **Percentage-based scroll preservation**: Approximate but effective approach

## 3-Way Review Results

### Gemini (86.8s)
**Verdict**: APPROVE

Key observations:
- Spec adherence follows 7-phase plan accurately
- XSS prevention via DOMPurify correctly applied
- Link security hardened with `target="_blank"` and `rel="noopener noreferrer"`
- Separation of concerns maintained between preview and existing modes
- State management uses `currentContent` as source of truth
- Graceful degradation for missing libraries

### Codex (63.6s)
**Verdict**: APPROVE

Key observations:
- Preview toggle hidden by default, only shown for markdown files
- Scroll position preserved when switching views
- DOMPurify sanitization mitigates script injection risks
- Libraries loaded conditionally to avoid unnecessary globals
- No unsafe `innerHTML` without sanitization

Minor considerations (non-blocking):
- `.markdown` and `.mdown` extensions not recognized (only `.md`)
- `document.write` could be migrated to static script tags in future

## Testing Summary

### Functional Tests Verified
- [x] Toggle button visible for .md files
- [x] Toggle button hidden for non-.md files
- [x] `isMarkdown` flag correctly set to true/false
- [x] CDN scripts only loaded for markdown files
- [x] Preview styling applied correctly
- [x] Build succeeds without errors

### Security Verification
- [x] DOMPurify.sanitize() applied to all marked.js output
- [x] Links rendered with `target="_blank" rel="noopener noreferrer"`
- [x] Error handling for missing libraries

## What Went Well

1. **Clean phase-based implementation**: Following the 7-phase plan kept changes organized
2. **Security-first approach**: DOMPurify integration was straightforward
3. **Existing patterns reused**: Followed CDN loading pattern from Prism.js
4. **Minimal server changes**: Only 2 lines added to open-server.ts
5. **Both consultants approved**: Clean implementation with no blocking issues

## Lessons Learned

1. **Template architecture matters**: Understanding the 3-container architecture (viewMode, editor, preview-container) was crucial for correct implementation per the plan's Architecture Clarification section
2. **Conditional loading works well**: Using `document.write` inside an `if` block cleanly handles conditional script loading
3. **Percentage scroll is "good enough"**: Perfect scroll mapping isn't necessary - approximate works fine

## Future Considerations

Per consultant feedback:
- Could add support for `.markdown` and `.mdown` extensions
- Could migrate from `document.write` to static `defer` scripts for CSP compliance
- Could extend to other previewable formats (HTML, SVG) as noted in spec

## Expert Consultation Log

| Model | Verdict | Duration | Key Feedback |
|-------|---------|----------|--------------|
| Gemini | APPROVE | 86.8s | Solid implementation, security correct, follows plan |
| Codex | APPROVE | 63.6s | Clean spec adherence, DOMPurify correctly integrated |

## Approval
- [x] Self-review complete
- [x] 3-way external review complete (2/2 APPROVE)
- [ ] Architect review (pending PR)
