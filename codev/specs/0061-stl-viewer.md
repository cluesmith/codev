# Spec 0061: 3D Model Viewer (STL + 3MF)

## Summary

Add 3D model viewing capability to the dashboard annotation viewer, supporting STL and 3MF formats. Enables users of OpenSCAD, FreeCAD, PrusaSlicer, Bambu Studio, and other CAD/slicer tools to view their 3D output directly via the `afx open` command.

## Goals

### Must Have

1. **STL file detection** - `afx open model.stl` recognizes STL files and serves 3D viewer
2. **3MF file detection** - `afx open model.3mf` recognizes 3MF files and serves 3D viewer
3. **3D rendering** - Display models with proper 3D visualization using WebGL
4. **Interactive controls** - Rotate, zoom, and pan using TrackballControls (quaternion-based, no gimbal lock)
5. **Binary and ASCII STL support** - Handle both STL formats
6. **Multi-color 3MF support** - Render 3MF files with per-object/per-triangle colors preserved
7. **Multi-object 3MF support** - Display all objects in a 3MF file
8. **Grid floor** - Show scale reference grid beneath model
9. **Lighting** - Appropriate lighting to show model surface details
10. **Error handling** - Clear error message for corrupt/invalid files

### Should Have

1. **Auto-center and fit** - Model automatically centered and scaled to fit viewport
2. **Theme support** - Match dashboard dark theme
3. **Model info** - Display filename and triangle count
4. **Reset view** - Button to reset camera to default position
5. **Standard views** - Buttons for +X/-X, +Y/-Y, +Z/-Z, and isometric views

### Nice to Have

1. **Wireframe toggle** - Option to view as wireframe
2. **Axes toggle** - Show/hide coordinate axes
3. **Grid toggle** - Show/hide floor grid
4. **Auto-reload** - Detect file changes and reload model automatically

## Technical Approach

### Library Choice: Three.js (ES Modules)

Use Three.js with ES Modules for modern dependency management:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
<script type="module">
  import * as THREE from 'three';
  import { STLLoader } from 'three/addons/loaders/STLLoader.js';
  import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
  import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
</script>
```

**Note**: 3MFLoader includes fflate for ZIP decompression internally.

**Offline consideration**: Viewer requires internet access to load Three.js from CDN. This is acceptable for a development tool. Bundling would add ~500KB to the package.

### Controls: TrackballControls

Use TrackballControls instead of OrbitControls:
- Quaternion-based rotation (no gimbal lock)
- Smooth rotation at all orientations including poles
- Standard CAD-style interaction

### Integration Points

1. **open-server.ts** - Detect `.stl` and `.3mf` extensions, serve 3D viewer template
2. **templates/3d-viewer.html** - Unified template for 3D model viewing
3. **Dashboard tabs** - 3D files open in annotation tab like other files

### Viewer Architecture

```
┌─────────────────────────────────────┐
│  3D Viewer (3d-viewer.html)         │
├─────────────────────────────────────┤
│  Header: [Views] [Toggles] [Info]   │
├─────────────────────────────────────┤
│  ┌─────────────────────────────┐    │
│  │     WebGL Canvas            │    │
│  │  ┌───────────────────┐      │    │
│  │  │   3D Model(s)     │      │    │
│  │  │   (with colors)   │      │    │
│  │  └───────────────────┘      │    │
│  │      Grid Floor + Axes      │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

## File Detection

| Format | Extension | MIME Type |
|--------|-----------|-----------|
| STL | `.stl` | `model/stl` |
| 3MF | `.3mf` | `model/3mf` or `application/vnd.ms-package.3dmanufacturing-3dmodel+xml` |

## Security Considerations

1. **Path validation** - open-server.ts already validates file exists and restricts saves to opened file
2. **MIME type** - Serve STL as `model/stl`, 3MF as `application/octet-stream`
3. **Template injection** - Use `{{PLACEHOLDER}}` replacement with proper escaping
4. **File size** - No explicit limit; browser will handle memory constraints

## Acceptance Criteria

1. `afx open path/to/model.stl` opens 3D viewer in dashboard tab
2. `afx open path/to/model.3mf` opens 3D viewer in dashboard tab
3. STL models render correctly with visible surface detail
4. Single-color 3MF files render with their assigned color
5. Multi-color 3MF files render with correct per-object/per-triangle colors
6. Multi-object 3MF files show all objects
7. Mouse drag rotates model without gimbal lock at any orientation
8. Scroll zooms, right-drag pans
9. Both binary and ASCII STL files load successfully
10. Invalid/corrupt files show clear error message
11. Works in Chrome, Firefox, Safari

## Testing Strategy

**Manual testing** (primary):
1. Test with sample STL files (binary and ASCII)
2. Test with single-color 3MF (e.g., from OpenSCAD)
3. Test with multi-color 3MF (e.g., from Bambu Studio)
4. Test with multi-object 3MF
5. Test rotation at poles (gimbal lock regression)
6. Test with large file (>10MB)
7. Test with corrupt file

**Test fixtures**: Create `tests/fixtures/3d/` with sample files for future automation.

## Out of Scope

- Other 3D formats (OBJ, GLTF) - future enhancement
- Model editing or measurement tools
- Animation support
- Multi-file assemblies
- Texture support (beyond what 3MFLoader provides)
- Offline support (CDN dependency acceptable)

## Dependencies

- Three.js r160+ (ES Modules, loaded via CDN)
- STLLoader, ThreeMFLoader, TrackballControls from Three.js examples
- fflate (bundled with 3MFLoader for ZIP decompression)
- Existing open-server.ts infrastructure

---

## Amendments

### TICK-001: Quaternion-based Trackball Rotation (2025-12-27)

**Summary**: Replace Euler angle rotation with quaternion math to eliminate gimbal lock

**Problem Addressed**:
The initial implementation uses OrbitControls with Euler angles for rotation, which causes gimbal lock when the camera approaches certain orientations (e.g., looking straight down). This makes the 3D navigation feel broken and unprofessional.

**Spec Changes**:
- Technical Approach: Use TrackballControls instead of OrbitControls, or implement custom quaternion-based rotation
- Acceptance Criteria: Add "Smooth rotation without gimbal lock at any orientation"

**Plan Changes**:
- Phase 1: Replace OrbitControls with TrackballControls (uses quaternions internally)
- Alternative: Implement custom quaternion rotation if TrackballControls has issues

**Review**: See `reviews/0061-stl-viewer-tick-001.md`

### TICK-002: 3MF Format Support with Multi-Color (2025-12-27)

**Summary**: Add native 3MF file viewing with proper multi-color/multi-material support

**Problem Addressed**:
Modern 3D printing workflows (PrusaSlicer, Bambu Studio, OrcaSlicer) use 3MF as the standard format. 3MF supports:
- Multiple objects in one file
- Per-object and per-triangle colors (Color Groups)
- Materials and textures
- Better metadata than STL

Currently users must convert 3MF to STL to view, losing color information.

**Spec Changes**:

1. **Goals - Must Have** additions:
   - 3MF file detection: `afx open model.3mf` recognizes 3MF files
   - Multi-color rendering: Display objects/triangles with their assigned colors
   - Multi-object support: Show all objects in a 3MF file

2. **Technical Approach**:
   - Use Three.js 3MFLoader (supports Color Groups, materials, textures)
   - 3MFLoader handles ZIP extraction and XML parsing internally
   - Returns a Group object containing meshes with vertex colors/materials

3. **Out of Scope** update:
   - Remove "3MF" from out-of-scope list
   - Keep: OBJ, GLTF (future), editing, animation, assemblies

**Acceptance Criteria**:
1. `afx open path/to/model.3mf` opens 3MF viewer in dashboard
2. Single-color 3MF files render with their assigned color
3. Multi-color 3MF files render with correct per-object/per-triangle colors
4. Multi-object 3MF files show all objects
5. Same controls as STL viewer (rotate, zoom, pan, reset)

**Plan Changes**:
- See TICK-002 section in plan

**Review**: See `reviews/0061-stl-viewer-tick-002.md`
