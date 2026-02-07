# Plan 0039: Codev CLI Implementation

**Spec:** codev/specs/0039-codev-cli.md
**Protocol:** SPIR
**Estimated effort:** 3-4 days

---

## Overview

Consolidate agent-farm, consult, and new codev commands into a single `@cluesmith/codev` npm package.

## Phase 1: Foundation (Day 1)

### 1.1 Create Package Structure

```bash
mkdir -p packages/codev/{src/commands,src/lib,bin,templates}
```

**Files to create:**
- `packages/codev/package.json` - New package config
- `packages/codev/tsconfig.json` - TypeScript config
- `packages/codev/src/cli.ts` - Main entry point
- `packages/codev/bin/codev.js` - Bin entry
- `packages/codev/bin/af.js` - Thin shim for af

### 1.2 Implement `codev doctor`

Port from `codev/bin/codev-doctor` (bash) to TypeScript:

```typescript
// src/commands/doctor.ts
const DEPENDENCIES = [
  { name: 'node', cmd: 'node --version', minVersion: '18.0.0' },
  { name: 'npm', cmd: 'npm --version' },
  { name: 'git', cmd: 'git --version' },
  { name: 'gh', cmd: 'gh --version', optional: true },
  { name: 'tmux', cmd: 'tmux -V' },
  { name: 'ttyd', cmd: 'ttyd --version' },
];
```

**Tests:**
- Missing dependency detection
- Version comparison
- Exit codes (0 = all good, 1 = missing critical)

### 1.3 Implement `codev init`

```typescript
// src/commands/init.ts
export async function init(projectName: string, options: { yes?: boolean }) {
  const targetDir = path.resolve(projectName);

  if (fs.existsSync(targetDir)) {
    throw new Error(`Directory ${projectName} already exists`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  await copyTemplate(getTemplatesDir(), targetDir);

  // Interactive prompts unless --yes
  if (!options.yes) {
    await promptProjectConfig(targetDir);
  }
}
```

**Tests:**
- Creates directory structure
- Copies all template files
- Handles existing directory error

### 1.4 Implement `codev adopt`

```typescript
// src/commands/adopt.ts
export async function adopt(options: { yes?: boolean }) {
  const cwd = process.cwd();
  const codevDir = path.join(cwd, 'codev');

  if (fs.existsSync(codevDir)) {
    throw new Error('codev/ already exists. Use `codev update` instead.');
  }

  const conflicts = detectConflicts(cwd);
  if (conflicts.length > 0 && !options.yes) {
    await promptConflictResolution(conflicts);
  }

  await copyTemplate(getTemplatesDir(), cwd, { skipConflicts: true });
}
```

**Tests:**
- Detects existing codev/ directory
- Handles CLAUDE.md conflicts
- Skips files correctly

---

## Phase 2: Merge agent-farm (Day 2)

### 2.1 Copy agent-farm Source

```bash
# Move source files
cp -r agent-farm/src/* packages/codev/src/agent-farm/

# Move templates
cp -r agent-farm/templates/* packages/codev/templates/
```

### 2.2 Update Import Paths

All imports in agent-farm code need updating:
- `../lib/state` → `./lib/state`
- Keep internal structure intact

### 2.3 Wire Up af Shim

```javascript
// bin/af.js
#!/usr/bin/env node
const { run } = require('../dist/cli.js');

// Inject 'agent-farm' as first argument
const args = process.argv.slice(2);
run(['agent-farm', ...args]);
```

### 2.4 Add agent-farm Subcommand

```typescript
// src/cli.ts
program
  .command('agent-farm')
  .alias('af')  // Also accessible as codev af
  .description('Agent farm commands (start, spawn, status, etc.)')
  .action(() => {
    // Delegate to agent-farm CLI
    require('./agent-farm/cli').run(process.argv.slice(3));
  });
```

**Tests:**
- `af start` works
- `af spawn --project 0039` works
- All existing af commands unchanged

---

## Phase 3: Port Consult (Day 2-3)

### 3.1 Create Consult Module

```typescript
// src/commands/consult/index.ts
import { spawn } from 'child_process';
import { Command } from 'commander';

interface ModelConfig {
  cli: string;
  args: string[];
  envVar: string | null;
}

const MODELS: Record<string, ModelConfig> = {
  gemini: { cli: 'gemini', args: ['--yolo'], envVar: 'GEMINI_SYSTEM_MD' },
  pro: { cli: 'gemini', args: ['--yolo'], envVar: 'GEMINI_SYSTEM_MD' },
  codex: { cli: 'codex', args: ['exec', '--full-auto'], envVar: 'CODEX_SYSTEM_MESSAGE' },
  gpt: { cli: 'codex', args: ['exec', '--full-auto'], envVar: 'CODEX_SYSTEM_MESSAGE' },
  claude: { cli: 'claude', args: ['--print', '--dangerously-skip-permissions'], envVar: null },
  opus: { cli: 'claude', args: ['--print', '--dangerously-skip-permissions'], envVar: null },
};
```

### 3.2 Implement Subcommands

```typescript
// PR review
async function reviewPR(model: string, prNumber: number) {
  const query = await buildPRQuery(prNumber);
  await runConsult(model, query);
}

// Spec review
async function reviewSpec(model: string, specNumber: number) {
  const specPath = await findSpec(specNumber);
  const query = await buildSpecQuery(specPath);
  await runConsult(model, query);
}

// Plan review
async function reviewPlan(model: string, planNumber: number) {
  const planPath = await findPlan(planNumber);
  const query = await buildPlanQuery(planPath);
  await runConsult(model, query);
}

// General query
async function general(model: string, query: string) {
  await runConsult(model, query);
}
```

### 3.3 Port Helper Functions

From Python consult:
- `loadRole()` - Read consultant.md
- `buildQuery()` - Format query with context
- `findSpec()` / `findPlan()` - Locate files by number
- History logging to `.consult/history.log`

**Tests:**
- Model routing works
- File location works
- CLI passthrough works
- Mock external CLIs

---

## Phase 4: Update Command (Day 3)

### 4.1 Implement Update Logic

```typescript
// src/commands/update.ts
interface UpdateResult {
  updated: string[];
  skipped: string[];
  conflicts: string[];
}

export async function update(options: { dryRun?: boolean; force?: boolean }): Promise<UpdateResult> {
  const embedded = getTemplatesDir();
  const local = path.join(process.cwd(), 'codev');

  const result: UpdateResult = { updated: [], skipped: [], conflicts: [] };

  for (const file of getUpdatableFiles()) {
    const embeddedPath = path.join(embedded, file);
    const localPath = path.join(local, file);

    if (!fs.existsSync(localPath)) {
      // New file - copy it
      if (!options.dryRun) {
        fs.copyFileSync(embeddedPath, localPath);
      }
      result.updated.push(file);
      continue;
    }

    const localHash = hashFile(localPath);
    const storedHash = getStoredHash(file);

    if (localHash === storedHash || options.force) {
      // Unchanged or force - safe to overwrite
      if (!options.dryRun) {
        fs.copyFileSync(embeddedPath, localPath);
        storeHash(file, hashFile(localPath));
      }
      result.updated.push(file);
    } else {
      // Modified by user - write as .codev-new
      if (!options.dryRun) {
        fs.copyFileSync(embeddedPath, localPath + '.codev-new');
      }
      result.conflicts.push(file);
    }
  }

  return result;
}
```

### 4.2 Hash Storage

```typescript
// Store hashes in codev/.update-hashes.json
interface HashStore {
  [filename: string]: string;
}
```

**Tests:**
- New files copied
- Unchanged files overwritten
- Modified files create .codev-new
- --dry-run shows but doesn't change
- --force overwrites everything

---

## Phase 5: Tower Command (Day 3)

### 5.1 Move from agent-farm

Tower is already implemented in agent-farm. Move it to codev commands:

```typescript
// src/commands/tower.ts
// Import existing tower logic from agent-farm
import { startTower } from '../agent-farm/commands/tower';

export async function tower() {
  await startTower();
}
```

### 5.2 Update Routing

Remove tower from af, add to codev:

```typescript
// src/cli.ts
program
  .command('tower')
  .description('Cross-project dashboard showing all agent-farm instances')
  .action(tower);
```

---

## Phase 6: Templates & Build (Day 4)

### 6.1 Embed codev-skeleton

```bash
# Build script copies skeleton to templates/
cp -r codev-skeleton/* packages/codev/templates/
```

### 6.2 Build Configuration

```json
// packages/codev/package.json
{
  "name": "@cluesmith/codev",
  "version": "1.0.0",
  "bin": {
    "codev": "./bin/codev.js",
    "af": "./bin/af.js"
  },
  "files": [
    "dist",
    "bin",
    "templates"
  ],
  "scripts": {
    "build": "tsc && npm run copy-templates",
    "copy-templates": "cp -r ../codev-skeleton/* templates/",
    "prepublishOnly": "npm run build"
  }
}
```

### 6.3 Test End-to-End

```bash
# Build
npm run build

# Link globally for testing
npm link

# Test all commands
codev doctor
codev init test-project
cd test-project
codev adopt  # Should fail (already has codev)
af start
af status
codev consult --model gemini general "Hello"
codev tower
codev update --dry-run
```

---

## Phase 7: Migration & Deprecation

### 7.1 Deprecation Notice

Add to @cluesmith/agent-farm:

```typescript
console.warn('⚠️  @cluesmith/agent-farm is deprecated. Please use @cluesmith/codev instead.');
console.warn('   npm uninstall -g @cluesmith/agent-farm');
console.warn('   npm install -g @cluesmith/codev');
```

### 7.2 Documentation

- Update README.md with new installation
- Update CLAUDE.md with codev commands
- Add MIGRATION.md for existing users

---

## Testing Checklist

- [ ] `codev doctor` checks all dependencies
- [ ] `codev init my-project` creates valid project
- [ ] `codev adopt` works in existing project
- [ ] `codev update` safely updates files
- [ ] `codev update --dry-run` shows changes
- [ ] `codev tower` shows cross-project view
- [ ] `codev consult --model gemini spec 39` works
- [ ] `codev consult --model codex pr 33` works
- [ ] `consult` alias works (bin/consult.js shim → codev consult)
- [ ] `af start` unchanged
- [ ] `af spawn --project 0039` unchanged
- [ ] `af status` unchanged
- [ ] All existing af commands work
- [ ] npm publish succeeds
- [ ] Global install works: `npm install -g @cluesmith/codev`

---

## Rollback Plan

If issues discovered after publish:

1. Keep @cluesmith/agent-farm available (don't unpublish)
2. Users can: `npm install -g @cluesmith/agent-farm@latest`
3. Fix issues in @cluesmith/codev
4. Re-publish with patch version

---

## Dependencies

- commander (CLI framework)
- chalk (colors)
- ora (spinners)
- execa (process spawning)
- better-sqlite3 (from agent-farm)
- express (from agent-farm)

---

## TICK Amendment: 2025-12-09

### Phase 8: Consolidate Consult Implementation

**Goal**: Single TypeScript implementation, delete Python version

#### 8.1 Port Codex Improvements to TypeScript

Update `packages/codev/src/commands/consult/codex.ts`:

```typescript
// Before (using undocumented env var):
const env = { CODEX_SYSTEM_MESSAGE: role };
const args = ['exec', '--full-auto', query];

// After (using official config flags):
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const instructionsFile = join(tmpdir(), `consult-${Date.now()}.md`);
writeFileSync(instructionsFile, role);

try {
  const args = [
    'exec',
    '-c', `experimental_instructions_file=${instructionsFile}`,
    '-c', 'model_reasoning_effort=low',
    '--full-auto',
    query
  ];
  // ... spawn codex
} finally {
  unlinkSync(instructionsFile);
}
```

#### 8.2 Delete Python Implementation

```bash
# Delete the Python script
rm codev/bin/consult

# Create shell shim for backwards compatibility
cat > codev/bin/consult << 'EOF'
#!/bin/bash
# Shim: delegates to TypeScript implementation
exec npx @cluesmith/codev consult "$@"
EOF
chmod +x codev/bin/consult
```

#### 8.3 Update Documentation

- Update CLAUDE.md/AGENTS.md consult examples to use `codev consult`
- Remove Python/typer dependency mentions
- Update test instructions

#### 8.4 Update Tests

- Ensure e2e consult tests work with TypeScript version
- Remove any Python-specific test helpers

### Exit Criteria (TICK-001)

- [x] `consult --model codex spec 39` uses `experimental_instructions_file`
- [x] `consult --model codex` uses `model_reasoning_effort=low`
- [x] Python `codev/bin/consult` is gone (shim remains for backwards compat)
- [x] All consult tests pass
- [x] Documentation updated

---

## Phase 9: Embedded Skeleton with Local Overrides (TICK-002)

### 9.1 Create skeleton resolver utility

```typescript
// src/lib/skeleton.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get path to embedded skeleton directory
 */
export function getSkeletonDir(): string {
  // In built package: dist/lib/skeleton.js -> ../../skeleton/
  // The skeleton is copied to packages/codev/skeleton/ at build time
  return path.resolve(__dirname, '../../skeleton');
}

/**
 * Resolve a codev file, checking local first then embedded skeleton
 */
export function resolveCodevFile(relativePath: string, projectRoot?: string): string | null {
  const root = projectRoot || findProjectRoot();

  // 1. Check local codev/ directory first
  const localPath = path.join(root, 'codev', relativePath);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // 2. Fall back to embedded skeleton
  const embeddedPath = path.join(getSkeletonDir(), relativePath);
  if (fs.existsSync(embeddedPath)) {
    return embeddedPath;
  }

  return null;
}

/**
 * Find project root by looking for codev/ directory or .git
 */
function findProjectRoot(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'codev')) ||
        fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}
```

### 9.2 Update consult to use resolver

```typescript
// src/commands/consult/index.ts
import { resolveCodevFile } from '../../lib/skeleton.js';

function loadRole(): string {
  const rolePath = resolveCodevFile('roles/consultant.md');
  if (!rolePath) {
    throw new Error('consultant.md not found in local codev/ or embedded skeleton');
  }
  return fs.readFileSync(rolePath, 'utf-8');
}
```

### 9.3 Update af to use resolver

Key files that need resolution:
- `roles/builder.md`
- `roles/architect.md`
- `protocols/spir/protocol.md`
- `protocols/tick/protocol.md`
- `config.json`

### 9.4 Update build process

```json
// package.json scripts
{
  "scripts": {
    "build": "tsc && npm run copy-skeleton",
    "copy-skeleton": "cp -r ../../codev-skeleton skeleton/"
  }
}
```

### 9.5 Update codev init

```typescript
// src/commands/init.ts
export async function init(projectName: string) {
  const targetDir = path.resolve(projectName);

  // Create minimal structure only
  fs.mkdirSync(path.join(targetDir, 'codev', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'codev', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'codev', 'reviews'), { recursive: true });

  // Copy only CLAUDE.md and AGENTS.md templates
  // (protocols, roles, etc. come from embedded skeleton at runtime)
}
```

### 9.6 Add codev eject command

```typescript
// src/commands/eject.ts
import { getSkeletonDir, resolveCodevFile } from '../lib/skeleton.js';

export async function eject(relativePath: string) {
  const skeletonPath = path.join(getSkeletonDir(), relativePath);
  const localPath = path.join(process.cwd(), 'codev', relativePath);

  if (!fs.existsSync(skeletonPath)) {
    throw new Error(`${relativePath} not found in skeleton`);
  }

  if (fs.existsSync(localPath)) {
    throw new Error(`${relativePath} already exists locally. Delete it first to re-eject.`);
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.copyFileSync(skeletonPath, localPath);
  console.log(`Ejected ${relativePath} to codev/${relativePath}`);
}
```

### 9.7 Remove packages/codev/templates/

Delete the duplicate templates directory - skeleton is now the single source of truth.

### 9.8 Update tests

- Test that resolver finds local files first
- Test that resolver falls back to embedded skeleton
- Test that eject copies correctly
- Test that init creates minimal structure

### Exit Criteria (TICK-002)

- [ ] `packages/codev/templates/` removed
- [ ] `skeleton/` directory created at build time from `codev-skeleton/`
- [ ] `resolveCodevFile()` utility implemented and tested
- [ ] `consult` uses resolver for consultant.md
- [ ] `af` uses resolver for roles and protocols
- [ ] `codev init` creates minimal structure (specs/, plans/, reviews/ only)
- [ ] `codev eject` command implemented
- [ ] Existing projects with full codev/ directory continue to work

---

## Phase 10: Revert to Copy-on-Init (TICK-003)

**Goal**: Revert TICK-002's embedded skeleton approach. Copy framework files to project during init for AI consultant accessibility.

### 10.1 Update codev init to copy all framework files

```typescript
// src/commands/init.ts
import { getSkeletonDir } from '../lib/skeleton.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FRAMEWORK_VERSION = '1.2.0'; // Read from package.json

export async function init(projectName: string) {
  const targetDir = path.resolve(projectName);
  const skeletonDir = getSkeletonDir();

  // Create base structure
  const codevDir = path.join(targetDir, 'codev');

  // Copy entire skeleton (protocols, roles, templates)
  copyDirRecursive(skeletonDir, codevDir, {
    addHeader: true,
    version: FRAMEWORK_VERSION
  });

  // Create user directories
  fs.mkdirSync(path.join(codevDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(codevDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(codevDir, 'reviews'), { recursive: true });

  // Write framework version
  fs.writeFileSync(
    path.join(codevDir, '.framework-version'),
    FRAMEWORK_VERSION
  );

  // Create projectlist.md if not copied
  // ...
}
```

### 10.2 Add managed file headers

```typescript
// src/lib/copy-utils.ts
const MANAGED_HEADER = `<!-- MANAGED BY CODEV - Run 'codev update' to refresh -->
<!-- Version: {{VERSION}} | Do not edit unless customizing -->

`;

function addManagedHeader(content: string, version: string): string {
  // Only add to markdown files
  return MANAGED_HEADER.replace('{{VERSION}}', version) + content;
}

function copyDirRecursive(src: string, dest: string, options: CopyOptions) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, options);
    } else {
      let content = fs.readFileSync(srcPath, 'utf-8');

      if (options.addHeader && entry.name.endsWith('.md')) {
        content = addManagedHeader(content, options.version);
      }

      fs.writeFileSync(destPath, content);
    }
  }
}
```

### 10.3 Implement codev update command

```typescript
// src/commands/update.ts
import * as crypto from 'node:crypto';

interface UpdateResult {
  updated: string[];
  skipped: string[];
  conflicts: string[];
  newVersion: string;
}

export async function update(options: { dryRun?: boolean; force?: boolean }): Promise<UpdateResult> {
  const codevDir = path.join(process.cwd(), 'codev');
  const skeletonDir = getSkeletonDir();

  const currentVersion = readFrameworkVersion(codevDir);
  const newVersion = getPackageVersion();

  const result: UpdateResult = {
    updated: [],
    skipped: [],
    conflicts: [],
    newVersion
  };

  // Get list of framework files (protocols/, roles/, templates/)
  const frameworkFiles = getFrameworkFiles(skeletonDir);

  for (const relPath of frameworkFiles) {
    const localPath = path.join(codevDir, relPath);
    const skeletonPath = path.join(skeletonDir, relPath);

    if (!fs.existsSync(localPath)) {
      // New file - copy it
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        copyWithHeader(skeletonPath, localPath, newVersion);
      }
      result.updated.push(relPath);
      continue;
    }

    // Check if user modified the file
    const localContent = fs.readFileSync(localPath, 'utf-8');
    const isManaged = localContent.includes('MANAGED BY CODEV');

    if (options.force || !isUserModified(localPath, skeletonPath)) {
      // Safe to overwrite
      if (!options.dryRun) {
        copyWithHeader(skeletonPath, localPath, newVersion);
      }
      result.updated.push(relPath);
    } else {
      // User modified - create .codev-new
      if (!options.dryRun) {
        copyWithHeader(skeletonPath, localPath + '.codev-new', newVersion);
      }
      result.conflicts.push(relPath);
    }
  }

  // Update version file
  if (!options.dryRun) {
    fs.writeFileSync(
      path.join(codevDir, '.framework-version'),
      newVersion
    );
  }

  return result;
}

function isUserModified(localPath: string, skeletonPath: string): boolean {
  const localContent = fs.readFileSync(localPath, 'utf-8');

  // Remove managed header for comparison
  const strippedLocal = stripManagedHeader(localContent);
  const skeletonContent = fs.readFileSync(skeletonPath, 'utf-8');

  return strippedLocal !== skeletonContent;
}
```

### 10.4 Remove runtime resolution from af/consult

Update these files to read directly from `codev/`:
- `src/commands/consult/index.ts` - Load from `codev/roles/consultant.md`
- `src/agent-farm/lib/roles.ts` - Load from `codev/roles/builder.md`

Remove the `resolveCodevFile()` fallback to embedded skeleton.

### 10.5 Update codev adopt

```typescript
// src/commands/adopt.ts
export async function adopt(options: { yes?: boolean }) {
  const cwd = process.cwd();
  const codevDir = path.join(cwd, 'codev');
  const skeletonDir = getSkeletonDir();

  // Copy framework files (protocols, roles, templates)
  copyDirRecursive(skeletonDir, codevDir, {
    addHeader: true,
    version: getPackageVersion(),
    skipExisting: true // Don't overwrite existing files
  });

  // Create user directories
  fs.mkdirSync(path.join(codevDir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(codevDir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(codevDir, 'reviews'), { recursive: true });

  // Write framework version
  fs.writeFileSync(
    path.join(codevDir, '.framework-version'),
    getPackageVersion()
  );
}
```

### 10.6 Update E2E tests

Update `tests/e2e/init.bats` and `tests/e2e/adopt.bats`:

```bash
@test "codev init creates protocols directory" {
  ./node_modules/.bin/codev init my-project --yes
  assert_dir_exists "my-project/codev/protocols"
  assert_dir_exists "my-project/codev/protocols/spir"
}

@test "codev init creates roles directory" {
  ./node_modules/.bin/codev init my-project --yes
  assert_dir_exists "my-project/codev/roles"
  assert_file_exists "my-project/codev/roles/builder.md"
}

@test "codev init adds managed header to framework files" {
  ./node_modules/.bin/codev init my-project --yes
  run cat my-project/codev/protocols/spir/protocol.md
  assert_output --partial "MANAGED BY CODEV"
}

@test "codev init creates .framework-version" {
  ./node_modules/.bin/codev init my-project --yes
  assert_file_exists "my-project/codev/.framework-version"
}
```

### 10.7 Remove codev eject command

Since files are now copied, eject is no longer needed.

### Exit Criteria (TICK-003)

- [ ] `codev init` copies protocols/, roles/, templates/ to project
- [ ] Copied .md files have managed header
- [ ] `codev/.framework-version` tracks version
- [ ] `codev update` implemented with merge strategy
- [ ] `codev update --dry-run` shows what would change
- [ ] `codev update --force` overwrites even modified files
- [ ] Runtime resolution removed from af and consult
- [ ] E2E tests updated and passing
- [ ] `codev eject` command removed
