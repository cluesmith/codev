# Plan 0053: afx open Image Support

**Spec:** [codev/specs/0053-af-open-image-support.md](../specs/0053-af-open-image-support.md)
**Status:** planned

---

## Phase 1: Backend - Image Detection and Serving

### 1.1 Update open-server.ts

**File:** `packages/codev/src/agent-farm/servers/open-server.ts`

Add image extension detection:
```typescript
const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const isImage = imageExtensions.includes(ext);
```

Add MIME type mapping:
```typescript
const mimeTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
};
```

Update `/api/content` endpoint:
- For images: return raw binary with correct Content-Type
- Pass `isImage` flag to template

### 1.2 Update Template Injection

Pass `isImage` to the template along with existing `lang`, `isMarkdown` flags.

---

## Phase 2: Frontend - Image Viewer UI

### 2.1 Update open.html

**File:** `packages/codev/templates/open.html`

Add image viewer section (hidden by default):
```html
<div id="image-viewer" style="display: none;">
  <div class="image-controls">
    <button onclick="zoomFit()">Fit</button>
    <button onclick="zoom100()">100%</button>
    <button onclick="zoomIn()">+</button>
    <button onclick="zoomOut()">-</button>
    <span id="image-info"></span>
  </div>
  <div class="image-container">
    <img id="image-display" />
  </div>
</div>
```

### 2.2 Image Display Logic

On load, if `isImage`:
- Hide code editor, preview button, edit button
- Show image viewer
- Load image via `/api/content`
- Display dimensions and file size

### 2.3 Zoom Controls

```javascript
let currentZoom = 'fit';

function zoomFit() {
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100%';
  img.style.width = 'auto';
  img.style.height = 'auto';
}

function zoom100() {
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.width = 'auto';
  img.style.height = 'auto';
}

function zoomIn() { /* scale by 1.25x */ }
function zoomOut() { /* scale by 0.8x */ }
```

### 2.4 CSS Styling

Center image in container, add scrollbars for overflow at 100%+ zoom.

---

## Phase 3: Testing

### 3.1 Manual Testing

- [ ] Open PNG file - displays correctly
- [ ] Open JPG file - displays correctly
- [ ] Open GIF file - displays correctly (animated if applicable)
- [ ] Open WebP file - displays correctly
- [ ] Open SVG file - renders as vector
- [ ] Zoom fit works
- [ ] Zoom 100% works
- [ ] Zoom in/out works
- [ ] Large image handles scrolling
- [ ] Non-image files still work normally

### 3.2 Edge Cases

- [ ] Very large image (>5000px) - should scroll
- [ ] Tiny image (<50px) - should not stretch
- [ ] Broken/corrupt image - shows error message
- [ ] File not found - existing error handling

---

## Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/servers/open-server.ts` | Image detection, MIME types, binary serving |
| `packages/codev/templates/open.html` | Image viewer UI, zoom controls |

---

## Estimated Scope

~150-200 lines of code changes across 2 files.
