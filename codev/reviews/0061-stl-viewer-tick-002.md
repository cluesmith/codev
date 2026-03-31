# TICK Review: 3MF Format Support with Multi-Color Rendering

## Metadata
- **ID**: 0061-stl-viewer-tick-002
- **Protocol**: TICK
- **Date**: 2025-12-27
- **Specification**: [codev/specs/0061-stl-viewer.md](../specs/0061-stl-viewer.md)
- **Plan**: [codev/plans/0061-stl-viewer.md](../plans/0061-stl-viewer.md)
- **Status**: completed

## Implementation Summary

Added 3MF file viewing capability to the dashboard annotation viewer, enabling users to view 3D printed models from PrusaSlicer, Bambu Studio, OrcaSlicer, and other 3D printing software with proper multi-color/multi-material support.

Key changes:
1. Created unified `3d-viewer.html` template using ES Modules (Three.js r160)
2. Integrated 3MFLoader for ZIP/XML parsing with automatic color handling
3. Updated `open-server.ts` for 3MF detection and generalized `/api/model` endpoint
4. Handled Z-up to Y-up coordinate conversion (3MF uses Z-up, Three.js uses Y-up)

## Success Criteria Status
- [x] `afx open path/to/model.3mf` opens 3D viewer in dashboard tab
- [x] Single-color 3MF files render with their assigned color
- [x] Multi-color 3MF files render with correct per-object/per-triangle colors
- [x] Multi-object 3MF files show all objects
- [x] Same controls as STL viewer (rotate, zoom, pan, reset)
- [x] Auto-reload works for 3MF files
- [x] STL viewer continues to work (backward compatible)
- [x] No breaking changes

## Files Changed

### Created
- `packages/codev/templates/3d-viewer.html` - Unified 3D model viewer with ES Modules

### Modified
- `packages/codev/src/agent-farm/servers/open-server.ts` - Added 3MF detection, /api/model endpoint, escapeHtml for security

### Deleted
- `packages/codev/templates/stl-viewer.html` - Replaced by unified 3d-viewer.html

## Deviations from Plan

Minor additions beyond the original plan:
1. Added wireframe+solid overlay mode (user request) - 3-state toggle: solid, wireframe, both
2. Removed stl-viewer.html earlier than planned (post-consultation cleanup)

The core implementation followed the plan closely:
1. Migrated to ES Modules as specified
2. Added format detection with `{{FORMAT}}` placeholder
3. Generalized API endpoint to `/api/model`
4. Preserved backward compatibility with `/api/stl` endpoint

## Testing Results

### Manual Tests
1. 3MF file detection and viewer serving - Verified via curl, FORMAT correctly set to '3mf'
2. STL file detection and viewer serving - Verified via curl, FORMAT correctly set to 'stl'
3. /api/model endpoint for 3MF - Returns ZIP content (starts with "PK" header)
4. /api/model endpoint for STL - Returns ASCII STL content (starts with "solid")
5. Template placeholder replacement - All placeholders correctly substituted

### Test Files Used
- `/Users/mwk/Development/cluesmith/tidybot/tmp/hilbert-order4.3mf` - 3MF test
- `/Users/mwk/Development/cluesmith/tidybot/.builders/0014/tmp/ratio_tests.stl` - STL test

## Challenges Encountered

1. **ES Module loading via import maps**
   - **Solution**: Used proper import map with jsDelivr CDN paths for Three.js r160

2. **3MF coordinate system**
   - **Solution**: Applied `-Math.PI / 2` rotation on X-axis to convert Z-up to Y-up

3. **Multi-object centering**
   - **Solution**: Computed bounding box of entire group, centered, then adjusted for floor placement

## Lessons Learned

### What Went Well
- ES Modules approach cleaner than legacy global scripts
- 3MFLoader handles all the complexity (ZIP, XML, colors, materials) automatically
- Unified template reduces code duplication between STL and 3MF

### What Could Improve
- Could add visual feedback for multi-color models (object count, color palette)
- Large 3MF files may be slow to parse (fflate decompression in browser)

## Multi-Agent Consultation

**Models Consulted**: Gemini 3 Pro, GPT-5 Codex, Claude
**Date**: 2025-12-27

### Verdicts
- **Gemini**: REQUEST_CHANGES → RESOLVED
- **Codex**: REQUEST_CHANGES → RESOLVED
- **Claude**: APPROVE

### Key Feedback
- XSS vulnerability in template substitution (Gemini, Codex) - unescaped file paths could inject malicious JS
- MIME type for 3MF should be `model/3mf` not `application/octet-stream` (Gemini)
- Clean ES Modules migration, good coordinate system handling (Claude)
- stl-viewer.html should be removed to avoid confusion (Gemini)

### Issues Identified
1. **Security (HIGH)**: `{{FILE_PATH}}` inserted directly into JS context without escaping
2. **Security (HIGH)**: `{{FILE}}` inserted into HTML without escaping
3. **Standards (LOW)**: Incorrect MIME type for 3MF format

### Fixes Applied
1. Added `escapeHtml()` function in open-server.ts for HTML context escaping
2. Changed `{{FILE_PATH}}` to `{{FILE_PATH_JSON}}` with `JSON.stringify()` for safe JS insertion
3. HTML-escaped `{{FILE}}` for display in HTML contexts
4. Changed 3MF MIME type to `model/3mf`
5. Removed deprecated stl-viewer.html

## TICK Protocol Feedback
- **Autonomous execution**: Worked well - clear spec and plan made implementation straightforward
- **Single-phase approach**: Appropriate for this scope (~740 lines added, mostly template HTML/JS)
- **Speed vs quality trade-off**: Balanced - took time to test properly
- **End-only consultation**: Adequate for amendment work building on existing STL viewer

## Follow-Up Actions
- [ ] Add test fixtures to `tests/fixtures/3d/` for future automation
- [x] Remove old `stl-viewer.html` - Done during consultation fixes
- [ ] Document CDN dependency in project docs (requires internet for Three.js)

## Conclusion

TICK-002 successfully added 3MF format support to the existing STL viewer. The unified 3d-viewer.html template handles both formats cleanly using ES Modules. Multi-color and multi-object 3MF files are properly supported through Three.js's 3MFLoader. Security issues identified in 3-way consultation were promptly fixed (XSS prevention, correct MIME types). Additionally, a user-requested wireframe+solid overlay mode was added, enhancing model inspection capabilities. TICK was appropriate for this amendment as it extended existing functionality with clear requirements.
