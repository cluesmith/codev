# Spec 0053: af open Image Support

**Status:** specified
**Protocol:** SPIR
**Priority:** Medium

---

## Overview

Extend `af open` to display images (PNG, JPG, GIF, WebP, SVG) in the dashboard viewer instead of showing binary garbage or errors.

---

## Requirements

### 1. Image Detection

Detect image files by extension:
- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`

### 2. Image Display

When an image file is opened:
- Display the image centered in the viewer
- Support zoom controls (fit to window, 100%, zoom in/out)
- Show image dimensions and file size in header
- No syntax highlighting or code editing UI

### 3. Integration

- Works with existing `af open <filepath>` command
- Opens in dashboard tab like other files
- Annotations not supported for images (line-based system doesn't apply; coordinate-based annotations may be added in future spec)

---

## Non-Goals

- Image editing (crop, rotate, etc.)
- Image format conversion
- Thumbnail generation

---

## Technical Approach

1. **open-server.ts**: Detect image extensions, set `isImage` flag
2. **open.html**:
   - If `isImage`, render `<img>` instead of code editor
   - Add zoom controls
   - Hide edit/preview buttons for images
3. **Serve image**: Return raw binary with correct MIME type for `/api/content` when image

---

## Success Criteria

- [ ] `af open screenshot.png` displays the image
- [ ] Zoom controls work (fit, 100%, +/-)
- [ ] Image dimensions shown in header
- [ ] SVG renders correctly
- [ ] Non-image files still work as before
