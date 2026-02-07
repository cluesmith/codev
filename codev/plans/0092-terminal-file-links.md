# Plan 0092: Terminal File Links and File Browser

## Overview

Three-phase implementation:
1. **Port Consolidation** (prerequisite) - Eliminate open-server.ts, serve files through Tower
2. **Terminal Links** - Clickable file paths via @xterm/addon-web-links
3. **File Browser** - Git status integration, Recent view, autocomplete search

## Phases (Machine Readable)

<!-- Required for porch phase tracking -->
```json
{
  "phases": [
    {"id": "phase_1", "title": "Port Consolidation"},
    {"id": "phase_2", "title": "Terminal Links"},
    {"id": "phase_3", "title": "File Browser Enhancement"}
  ]
}
```

---

## Phase 1: Port Consolidation (~4h)

**Goal**: Remove `open-server.ts` and serve file content through Tower. This is a prerequisite because terminal links need `createFileTab()` to work via Tower API.

### 1.1 Add file tab endpoints to Tower

**File**: `packages/codev/src/agent-farm/servers/tower-server.ts`

Add in the project-specific route handler section:

```typescript
// Track file tabs in project state
interface FileTab {
  id: string;
  path: string;
  createdAt: number;
}

// In-memory file tabs per project (alongside terminals)
const projectFileTabs = new Map<string, Map<string, FileTab>>();

// POST /api/tabs/file - Create file tab
if (req.method === 'POST' && apiPath === 'tabs/file') {
  const body = await readJsonBody(req);
  const filePath = body.path;

  if (!filePath || typeof filePath !== 'string') {
    return jsonResponse({ error: 'Missing path' }, 400);
  }

  // Resolve and validate path
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectPath, filePath);

  if (!fs.existsSync(fullPath)) {
    return jsonResponse({ error: 'File not found' }, 404);
  }

  // Security: ensure path is within project
  if (!fullPath.startsWith(projectPath)) {
    return jsonResponse({ error: 'Path outside project' }, 403);
  }

  // Check if already open
  const tabs = projectFileTabs.get(projectPath) || new Map();
  for (const [id, tab] of tabs) {
    if (tab.path === fullPath) {
      return jsonResponse({ id, existing: true });
    }
  }

  // Create new tab
  const id = `file-${Date.now().toString(36)}`;
  tabs.set(id, { id, path: fullPath, createdAt: Date.now() });
  projectFileTabs.set(projectPath, tabs);

  return jsonResponse({ id, existing: false });
}

// GET /api/file/:id - Get file content
const fileMatch = apiPath.match(/^file\/([^/]+)$/);
if (req.method === 'GET' && fileMatch) {
  const tabId = fileMatch[1];
  const tabs = projectFileTabs.get(projectPath);
  const tab = tabs?.get(tabId);

  if (!tab) {
    return jsonResponse({ error: 'Tab not found' }, 404);
  }

  try {
    const content = fs.readFileSync(tab.path, 'utf-8');
    const ext = path.extname(tab.path).slice(1).toLowerCase();
    return jsonResponse({
      path: tab.path,
      name: path.basename(tab.path),
      content,
      language: getLanguage(ext),
      isMarkdown: ext === 'md',
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
}

// GET /api/file/:id/raw - Get raw file (for images/video)
const fileRawMatch = apiPath.match(/^file\/([^/]+)\/raw$/);
if (req.method === 'GET' && fileRawMatch) {
  const tabId = fileRawMatch[1];
  const tabs = projectFileTabs.get(projectPath);
  const tab = tabs?.get(tabId);

  if (!tab) {
    return new Response('Not found', { status: 404 });
  }

  const data = fs.readFileSync(tab.path);
  const mimeType = getMimeType(tab.path);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(data);
  return;
}

// POST /api/file/:id/save - Save file
const fileSaveMatch = apiPath.match(/^file\/([^/]+)\/save$/);
if (req.method === 'POST' && fileSaveMatch) {
  const tabId = fileSaveMatch[1];
  const tabs = projectFileTabs.get(projectPath);
  const tab = tabs?.get(tabId);

  if (!tab) {
    return jsonResponse({ error: 'Tab not found' }, 404);
  }

  const body = await readJsonBody(req);
  fs.writeFileSync(tab.path, body.content, 'utf-8');
  return jsonResponse({ success: true });
}

// DELETE /api/tabs/:id - Close tab (already exists for terminals, extend for files)
// Update existing handler to check file tabs too
```

Helper functions to add:

```typescript
function getLanguage(ext: string): string {
  const langMap: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', sh: 'bash', bash: 'bash', md: 'markdown',
    html: 'markup', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
  };
  return langMap[ext] || ext;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
```

### 1.2 Create FileViewer component

**File**: `packages/codev/dashboard/src/components/FileViewer.tsx` (new)

Port the annotation viewer functionality from `templates/open.html`:

```typescript
import { useState, useEffect } from 'react';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';

interface FileViewerProps {
  tabId: string;
  onClose: () => void;
}

interface FileData {
  path: string;
  name: string;
  content: string;
  language: string;
  isMarkdown: boolean;
}

export function FileViewer({ tabId, onClose }: FileViewerProps) {
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [content, setContent] = useState('');

  useEffect(() => {
    fetch(`/api/file/${tabId}`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        setContent(d.content);
      })
      .catch(e => setError(e.message));
  }, [tabId]);

  const handleSave = async () => {
    await fetch(`/api/file/${tabId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setModified(false);
  };

  if (error) return <div className="file-error">{error}</div>;
  if (!data) return <div className="file-loading">Loading...</div>;

  // Render based on file type
  const ext = data.name.split('.').pop()?.toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '');
  const isVideo = ['mp4', 'webm', 'mov'].includes(ext || '');

  if (isImage) {
    return <img src={`/api/file/${tabId}/raw`} alt={data.name} className="file-image" />;
  }

  if (isVideo) {
    return <video src={`/api/file/${tabId}/raw`} controls className="file-video" />;
  }

  // Text file with syntax highlighting
  return (
    <div className="file-viewer">
      <div className="file-header">
        <span>{data.path}</span>
        {modified && <button onClick={handleSave}>Save</button>}
      </div>
      <pre className={`language-${data.language}`}>
        <code dangerouslySetInnerHTML={{
          __html: Prism.highlight(content, Prism.languages[data.language] || Prism.languages.plain, data.language)
        }} />
      </pre>
    </div>
  );
}
```

### 1.3 Update Dashboard to support file tabs

**File**: `packages/codev/dashboard/src/components/Dashboard.tsx`

Add file tab type:

```typescript
type TabType = 'terminal' | 'file';

interface Tab {
  id: string;
  type: TabType;
  label: string;
  // For terminals:
  wsPath?: string;
  // For files:
  filePath?: string;
}

// In render:
{activeTab.type === 'terminal' ? (
  <Terminal wsPath={activeTab.wsPath!} ... />
) : (
  <FileViewer tabId={activeTab.id} onClose={() => closeTab(activeTab.id)} />
)}
```

### 1.4 Update `af open` command

**File**: `packages/codev/src/agent-farm/commands/open.ts`

Remove the fallback to open-server.js:

```typescript
export async function open(options: OpenOptions): Promise<void> {
  // ... resolve filePath ...

  // Try Tower API (will work when dashboard is running)
  const opened = await tryDashboardApi(filePath);
  if (opened) {
    return;
  }

  // No fallback - just tell user to start dashboard
  fatal('Dashboard not running. Start with: af dash start');
}
```

### 1.5 Delete open-server.ts and clean up config

**Files to delete**:
- `packages/codev/src/agent-farm/servers/open-server.ts`

**Files to modify**:

`packages/codev/src/agent-farm/utils/config.ts`:
```diff
- openPortRange: [basePort + 50, basePort + 69] as [number, number],
```

`packages/codev/src/agent-farm/utils/port-registry.ts`:
```diff
- openPortRange: [basePort + 50, basePort + 69] as [number, number],
```

`packages/codev/src/agent-farm/types.ts`:
```diff
  interface AgentFarmConfig {
-   openPortRange: [number, number];
    // ... rest
  }
```

### 1.6 Test Phase 1

```bash
# Build and install
cd packages/codev && npm run build && npm pack && npm install -g ./cluesmith-codev-*.tgz

# Start tower and dashboard
af tower start
af dash start

# Test af open
af open README.md  # Should open in dashboard tab

# Verify no open-server processes
ps aux | grep open-server  # Should find nothing

# Verify no ports in 4250-4269 range
lsof -i :4250-4269  # Should be empty
```

---

## Phase 2: Terminal Links (~2h)

### 2.1 Add @xterm/addon-web-links

```bash
cd packages/codev/dashboard && npm install @xterm/addon-web-links
```

### 2.2 Create file path utilities

**File**: `packages/codev/dashboard/src/lib/filePaths.ts` (new)

```typescript
export const FILE_PATH_REGEX = /(?:^|[\s"'`(])([.\/\w-]+\.[a-zA-Z]{1,10})(?::(\d+)(?::(\d+))?)?/g;

export interface ParsedFilePath {
  path: string;
  line?: number;
  column?: number;
}

export function parseFilePath(match: string): ParsedFilePath {
  const parts = match.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
  if (!parts) return { path: match };
  return {
    path: parts[1],
    line: parts[2] ? parseInt(parts[2], 10) : undefined,
    column: parts[3] ? parseInt(parts[3], 10) : undefined,
  };
}
```

### 2.3 Update Terminal.tsx

**File**: `packages/codev/dashboard/src/components/Terminal.tsx`

```typescript
import { WebLinksAddon } from '@xterm/addon-web-links';
import { FILE_PATH_REGEX, parseFilePath } from '../lib/filePaths.js';

// Add props
interface TerminalProps {
  wsPath: string;
  projectPath: string;
  onFileOpen?: (path: string, line?: number) => void;
}

// In useEffect, after loading other addons:
const webLinksAddon = new WebLinksAddon(
  async (event, uri) => {
    event.preventDefault();
    const parsed = parseFilePath(uri);
    onFileOpen?.(parsed.path, parsed.line);
  },
  { urlRegex: FILE_PATH_REGEX }
);
term.loadAddon(webLinksAddon);
```

### 2.4 Wire up file opening in Dashboard

When terminal link clicked, create file tab via API.

---

## Phase 3: File Browser Enhancement (~3h)

### 3.1 Add git status endpoint

**File**: `tower-server.ts`

```typescript
// GET /api/git/status
if (req.method === 'GET' && apiPath === 'git/status') {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: projectPath,
      timeout: 5000,
    });

    const files = stdout.trim().split('\n')
      .filter(line => line.length > 0)
      .slice(0, 50)
      .map(line => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3),
      }));

    return jsonResponse({ files });
  } catch (e) {
    return jsonResponse({ files: [], error: (e as Error).message });
  }
}
```

### 3.2 Create useGitStatus hook

**File**: `packages/codev/dashboard/src/hooks/useGitStatus.ts` (new)

### 3.3 Create FileSearch component

**File**: `packages/codev/dashboard/src/components/FileSearch.tsx` (new)

### 3.4 Enhance FileTree.tsx

- Add view mode toggle (Recent | Tree)
- Add git status indicators
- Add search box at top
- Collapse node_modules/.git/.builders by default

---

## File Summary

### Phase 1 (Port Consolidation)
| File | Action |
|------|--------|
| `tower-server.ts` | Add file tab endpoints |
| `dashboard/src/components/FileViewer.tsx` | New |
| `dashboard/src/components/Dashboard.tsx` | Add file tab support |
| `commands/open.ts` | Remove open-server fallback |
| `servers/open-server.ts` | **DELETE** |
| `utils/config.ts` | Remove openPortRange |
| `utils/port-registry.ts` | Remove openPortRange |
| `types.ts` | Remove openPortRange |

### Phase 2 (Terminal Links)
| File | Action |
|------|--------|
| `dashboard/package.json` | Add @xterm/addon-web-links |
| `dashboard/src/lib/filePaths.ts` | New |
| `dashboard/src/components/Terminal.tsx` | Add link addon |

### Phase 3 (File Browser)
| File | Action |
|------|--------|
| `tower-server.ts` | Add git status endpoint |
| `dashboard/src/hooks/useGitStatus.ts` | New |
| `dashboard/src/components/FileSearch.tsx` | New |
| `dashboard/src/components/FileTree.tsx` | Enhance |

## Estimated Total: ~9h
