# Spec Review: 0029-meta-dashboard

## Verdict: REQUEST_CHANGES

## Analysis
The specification provides a solid foundation for a centralized "Meta-Dashboard" to manage multiple Agent Farm instances. The scope is well-bounded, and the reliance on the existing `ports.json` registry is architecturally sound.

However, the "Launch New Instance" feature is currently underspecified, particularly regarding the UI mechanism for directory selection and the lifecycle management of the spawned processes.

## Required Changes

### 1. Launch Mechanism Specification
**Current:** "Directory picker + spawn new agent-farm instance"
**Critique:** Web browsers do not provide a native "Directory Picker" that returns a server-accessible absolute path without specific non-standard attributes (like `webkitdirectory`), which often only return file lists, not the path itself in a way usable by `spawn`.
**Request:**
-   Clarify the UI control for selecting the directory. Will it be a simple text input accepting an absolute path? Or a custom server-side directory navigation API (listing folders, allowing click-to-navigate)?
-   Specify how the `afx` command is located and invoked.

### 2. Process Lifecycle Management
**Current:** Implicit "Launch" capability.
**Critique:** When `afx meta` spawns a new instance:
-   Is the new process **detached**? If I close the terminal running `afx meta`, do all child instances die?
-   Where do the **logs** (stdout/stderr) of the spawned instances go? Are they piped to the meta-dashboard's console, written to a file, or ignored?
-   **Recommendation:** Spawned instances should likely be detached so they survive the meta-dashboard restarting, but this needs to be explicit.

### 3. "Stopped" State Logic
**Current:** "Status indication (running/stopped) based on port availability"
**Verification:** Validated against `agent-farm/src/utils/port-registry.ts`. The registry keeps entries even when the PID is dead, so "Stopped" instances *will* be listable. This is feasible.
**Request:** Explicitly state that "Stopped" is determined by (Entry exists in Registry AND (PID is missing/dead OR Ports are not listening)).

### 4. Security / Path Validation
**Critique:** Allowing an arbitrary path spawn via a web UI (even on localhost) carries risks if not validated.
**Request:** Add a note about validating that the target directory is a valid Agent Farm project (e.g., contains `.agent-farm/` or `package.json`) before attempting to spawn.

## Minor Notes
-   **CLI Command:** `afx meta` is good.
-   **Port:** 4100 is a reasonable default.

Please update the "Technical Approach" section to address the Launch implementation details and Process lifecycle.