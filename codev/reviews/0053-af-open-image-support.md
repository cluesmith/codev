# Review: afx open Image Support

## Metadata
- **ID**: 0053
- **Status**: implemented
- **Specification**: codev/specs/0053-af-open-image-support.md
- **Plan**: codev/plans/0053-af-open-image-support.md
- **Implementation Date**: 2025-12-13

## Summary

This review documents the implementation of image viewing support for the `afx open` command. The feature allows users to view PNG, JPG, GIF, WebP, and SVG images in the dashboard viewer with zoom controls, replacing the previous behavior of showing binary garbage or errors.

## Implementation Overview

### Files Changed
1. **`packages/codev/src/agent-farm/servers/open-server.ts`** (+50 lines)
   - Added `imageExtensions` array for detecting image files
   - Added `imageMimeTypes` mapping for serving correct Content-Type headers
   - Added `isImage` flag and `fileSize` to template placeholders
   - Added `/api/image` endpoint for serving raw image binary data
   - Conditional template injection: `initImage()` for images, `init()` for text

2. **`packages/codev/templates/open.html`** (+230 lines)
   - Added image viewer state variables (`currentZoomMode`, `currentZoomLevel`, etc.)
   - Added image viewer HTML with zoom controls (Fit, 100%, +, -)
   - Added CSS styling for image viewer container with centered layout
   - Added `initImage()` function to hide code UI and show image viewer
   - Added zoom control functions: `zoomFit()`, `zoom100()`, `zoomIn()`, `zoomOut()`
   - Added image info display in both header and controls areas
   - Added error handling for corrupt/missing images

### Key Decisions
1. **Separate `/api/image` endpoint**: Rather than modifying `/file`, created a dedicated endpoint that serves binary data with correct MIME types
2. **Cache-busting via query param**: Using `?t=<timestamp>` allows reload button to work
3. **CSS class-based zoom**: Using `zoom-fit`, `zoom-100`, `zoom-custom` classes for different modes
4. **Dual info display**: Image dimensions shown in both header (per spec) and control bar (for convenience)
5. **Hidden code UI**: When viewing images, code editor, edit button, and preview toggle are hidden

## 3-Way Review Results

### Gemini (71.6s)
**Verdict**: APPROVE

Key observations:
- Requirement coverage complete for image detection, display, and zoom
- Clean separation of image vs. text logic
- Noted that disabling line-based annotations for images is the correct decision
- API endpoint using `/api/image` instead of `/api/content` is acceptable
- Code quality is good with proper CSS flexbox usage

### Codex (35.9s)
**Verdict**: REQUEST_CHANGES

Issues raised:
1. **Image dimensions not in header** (FIXED: Added `#image-header-info` element)
2. **Annotation system disabled for images** (DEFERRED: See "Known Limitations")

## Testing Summary

### Functional Tests Verified
- [x] `afx open test.svg` displays SVG correctly
- [x] `afx open test.png` displays PNG correctly
- [x] `afx open gradient.png` displays larger image with scrolling
- [x] Zoom Fit button centers image within viewport
- [x] Zoom 100% shows actual pixel size
- [x] Zoom +/- buttons scale correctly (10% min, 1000% max)
- [x] Image dimensions and file size shown in header
- [x] Non-image files still work as before
- [x] Server returns 400 for `/api/image` on non-image files

### Edge Cases Verified
- [x] Small images (<50px) don't stretch
- [x] Large images (>5000px) scroll correctly at 100%
- [x] Cache-busting query param doesn't break endpoint matching

## What Went Well

1. **Plan followed closely**: Implementation matched the phased plan accurately
2. **MIME types correct**: All supported image types serve with proper Content-Type
3. **Clean UI separation**: Image viewer is completely separate from code editor
4. **Responsive zoom**: Zoom controls work smoothly with CSS transitions
5. **Error handling**: Corrupt images show error message instead of breaking

## Known Limitations

### Annotation System for Images
The spec states "Same annotation system available (for annotating screenshots)". The implementation hides the annotation UI for images because:

1. The existing annotation system is line-based (tied to source code lines)
2. Image annotation would require a completely different approach (coordinate-based regions)
3. Implementing image annotation is a significant new feature beyond "extending" the existing system
4. Gemini's review explicitly called this "the correct technical decision"

**Recommendation**: If image annotation is needed, create a separate spec for coordinate-based annotation system.

## Lessons Learned

1. **Query params matter**: Initial `/api/image` exact-match check failed because the client uses `?t=...` for cache-busting. Using `startsWith()` fixed this.
2. **Test cleanup is critical**: Stale node processes from previous tests can cause confusing test failures. Always kill processes before testing.
3. **Spec interpretation**: "Same annotation system available" was interpreted by one reviewer as needing image annotation, while another correctly noted this is technically infeasible without a new system.

## Expert Consultation Log

| Model | Verdict | Duration | Key Feedback |
|-------|---------|----------|--------------|
| Gemini | APPROVE | 71.6s | Good implementation, correct to disable line-based annotations for images |
| Codex | REQUEST_CHANGES | 35.9s | Fixed: header info. Deferred: image annotation (requires new feature) |

## Approval
- [x] Self-review complete
- [x] 3-way external review complete (1 APPROVE, 1 REQUEST_CHANGES with issues addressed/deferred)
- [ ] Architect review (pending PR)
