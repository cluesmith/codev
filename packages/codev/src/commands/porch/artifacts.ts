/**
 * Artifact Resolver — pluggable backend for codev artifact access.
 *
 * Decouples porch from filesystem assumptions. Two backends:
 * - LocalResolver: reads from codev/specs/, codev/plans/ (default, backward compatible)
 * - FavaTrailsResolver: shells out to `fava-trails get` CLI
 *
 * Spec 559: Porch FAVA Trails Artifact Resolver
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';

// =============================================================================
// Interface
// =============================================================================

export interface ArtifactResolver {
  /** Find spec basename by numeric ID (e.g., "0559-porch-fava-trails-artifact-resolver") */
  findSpecBaseName(projectId: string, title: string): string | null;

  /** Get full content of a spec by project ID */
  getSpecContent(projectId: string, title: string): string | null;

  /** Get full content of a plan by project ID */
  getPlanContent(projectId: string, title: string): string | null;

  /** Check if a spec/plan has pre-approval frontmatter */
  hasPreApproval(artifactGlob: string): boolean;
}

// =============================================================================
// Local Resolver (default — reads from codev/ directory)
// =============================================================================

export class LocalResolver implements ArtifactResolver {
  constructor(private workspaceRoot: string) {}

  findSpecBaseName(projectId: string, _title: string): string | null {
    const specsDir = path.join(this.workspaceRoot, 'codev', 'specs');
    if (!fs.existsSync(specsDir)) return null;

    const normalizedId = projectId.replace(/^0+/, '') || '0';
    try {
      const files = fs.readdirSync(specsDir);
      const specFile = files.find(f => {
        if (!f.endsWith('.md')) return false;
        const numMatch = f.match(/^(\d+)/);
        if (!numMatch) return false;
        return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
      });
      return specFile ? specFile.replace(/\.md$/, '') : null;
    } catch {
      return null;
    }
  }

  getSpecContent(projectId: string, title: string): string | null {
    const baseName = this.findSpecBaseName(projectId, title);
    if (!baseName) return null;
    const filePath = path.join(this.workspaceRoot, 'codev', 'specs', `${baseName}.md`);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  getPlanContent(projectId: string, title: string): string | null {
    // Try new location first: codev/projects/<id>-<name>/plan.md
    const projectsDir = path.join(this.workspaceRoot, 'codev', 'projects');
    if (fs.existsSync(projectsDir)) {
      const normalizedId = projectId.replace(/^0+/, '') || '0';
      try {
        const dirs = fs.readdirSync(projectsDir);
        const projDir = dirs.find(d => {
          const numMatch = d.match(/^(\d+)/);
          if (!numMatch) return false;
          return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
        });
        if (projDir) {
          const planPath = path.join(projectsDir, projDir, 'plan.md');
          if (fs.existsSync(planPath)) {
            return fs.readFileSync(planPath, 'utf-8');
          }
        }
      } catch { /* continue to legacy */ }
    }

    // Legacy location: codev/plans/<id>-*.md
    const plansDir = path.join(this.workspaceRoot, 'codev', 'plans');
    if (!fs.existsSync(plansDir)) return null;

    const normalizedId = projectId.replace(/^0+/, '') || '0';
    try {
      const files = fs.readdirSync(plansDir);
      const planFile = files.find(f => {
        if (!f.endsWith('.md')) return false;
        const numMatch = f.match(/^(\d+)/);
        if (!numMatch) return false;
        return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
      });
      if (planFile) {
        return fs.readFileSync(path.join(plansDir, planFile), 'utf-8');
      }
    } catch { /* ignore */ }

    return null;
  }

  hasPreApproval(artifactGlob: string): boolean {
    const matches = globSync(artifactGlob, { cwd: this.workspaceRoot });
    if (matches.length === 0) return false;

    const filePath = path.join(this.workspaceRoot, matches[0]);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return false;

      const frontmatter = frontmatterMatch[1];
      const hasApproved = /^approved:\s*.+$/m.test(frontmatter);
      const hasValidated = /^validated:\s*\[.+\]$/m.test(frontmatter);
      return hasApproved && hasValidated;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// FAVA Trails Resolver (shells out to fava-trails CLI)
// =============================================================================

export class FavaTrailsResolver implements ArtifactResolver {
  private cache = new Map<string, string | null>();
  private extraEnv: Record<string, string>;

  constructor(private scope: string, workspaceRoot?: string) {
    // Read FAVA_TRAILS_DATA_REPO from .env if not already in process.env.
    // af_builder.sh injects this into builder worktree .env files.
    this.extraEnv = {};
    if (!process.env.FAVA_TRAILS_DATA_REPO && workspaceRoot) {
      const envPath = path.join(workspaceRoot, '.env');
      try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^FAVA_TRAILS_DATA_REPO=(.+)$/m);
        if (match) {
          this.extraEnv.FAVA_TRAILS_DATA_REPO = match[1].trim();
        }
      } catch { /* .env may not exist */ }
    }
  }

  findSpecBaseName(projectId: string, _title: string): string | null {
    const children = this.listChildren('specs');
    if (!children) return null;

    const normalizedId = projectId.replace(/^0+/, '') || '0';
    const match = children.find(name => {
      const numMatch = name.match(/^(\d+)/);
      if (!numMatch) return false;
      return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
    });
    return match || null;
  }

  getSpecContent(projectId: string, _title: string): string | null {
    const baseName = this.findSpecBaseName(projectId, _title);
    if (!baseName) return null;
    return this.getContent(`specs/${baseName}`);
  }

  getPlanContent(projectId: string, _title: string): string | null {
    const baseName = this.findPlanBaseName(projectId);
    if (!baseName) return null;
    return this.getContent(`plans/${baseName}`);
  }

  hasPreApproval(_artifactGlob: string): boolean {
    // FAVA Trails thoughts use validation_status in frontmatter, not approved/validated fields.
    // For now, check if the thought has validation_status: approved.
    // This requires --with-frontmatter. For v1, return false (no pre-approval in FAVA Trails).
    return false;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private findPlanBaseName(projectId: string): string | null {
    const children = this.listChildren('plans');
    if (!children) return null;

    const normalizedId = projectId.replace(/^0+/, '') || '0';
    const match = children.find(name => {
      const numMatch = name.match(/^(\d+)/);
      if (!numMatch) return false;
      return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
    });
    return match || null;
  }

  private listChildren(subPath: string): string[] | null {
    const cacheKey = `list:${subPath}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return cached ? cached.split('\n').filter(Boolean) : null;
    }

    const scopePath = `${this.scope}/${subPath}`;
    try {
      const output = execFileSync('fava-trails', ['get', '--list', scopePath], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ...this.extraEnv },
      }).trim();
      this.cache.set(cacheKey, output || null);
      return output ? output.split('\n').filter(Boolean) : null;
    } catch (err: unknown) {
      this.handleError(err, scopePath);
      this.cache.set(cacheKey, null);
      return null;
    }
  }

  private getContent(subPath: string): string | null {
    const cacheKey = `content:${subPath}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    const scopePath = `${this.scope}/${subPath}`;
    try {
      const output = execFileSync('fava-trails', ['get', scopePath], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ...this.extraEnv },
      });
      this.cache.set(cacheKey, output);
      return output;
    } catch (err: unknown) {
      this.handleError(err, scopePath);
      this.cache.set(cacheKey, null);
      return null;
    }
  }

  private handleError(err: unknown, scopePath: string): void {
    if (err && typeof err === 'object' && 'code' in err) {
      if ((err as { code: string }).code === 'ENOENT') {
        throw new Error(
          `fava-trails CLI not found. Install with: pip install fava-trails\n` +
          `Or: uv tool install fava-trails`
        );
      }
    }
    // Non-zero exit — log stderr for debugging, then return null (caller handles missing artifacts)
    if (err && typeof err === 'object' && 'stderr' in err) {
      const stderr = (err as { stderr: string }).stderr;
      if (stderr) {
        console.error(`[porch] fava-trails get ${scopePath}: ${stderr.trim()}`);
      }
    }
  }
}

// =============================================================================
// Config Resolution
// =============================================================================

/**
 * Find the root directory containing af-config.json.
 * In builder worktrees, af-config.json only exists in the main repo.
 * Falls back to the main repo via git worktree resolution.
 */
export function findConfigRoot(workspaceRoot: string): string {
  if (fs.existsSync(path.join(workspaceRoot, 'af-config.json'))) {
    return workspaceRoot;
  }
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitCommonDir !== '.git') {
      const mainGitDir = path.resolve(workspaceRoot, gitCommonDir);
      const mainRepo = path.dirname(mainGitDir.replace(/\/worktrees\/[^/]+$/, ''));
      if (fs.existsSync(path.join(mainRepo, 'af-config.json'))) {
        return mainRepo;
      }
    }
  } catch { /* not in git */ }
  return workspaceRoot;
}

// =============================================================================
// Factory
// =============================================================================

export interface ArtifactConfig {
  backend?: 'local' | 'fava-trails';
  scope?: string;
}

/**
 * Load artifact resolver config from af-config.json.
 * Resolves to main repo when running from a builder worktree.
 */
function loadArtifactConfig(workspaceRoot: string): ArtifactConfig | null {
  const configRoot = findConfigRoot(workspaceRoot);
  const configPath = path.join(configRoot, 'af-config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (typeof config?.artifacts === 'object') {
      return config.artifacts as ArtifactConfig;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Create the appropriate artifact resolver for this workspace.
 */
export function getResolver(workspaceRoot: string): ArtifactResolver {
  const config = loadArtifactConfig(workspaceRoot);

  if (config?.backend === 'fava-trails') {
    if (!config.scope) {
      throw new Error(
        `af-config.json has artifacts.backend: "fava-trails" but no artifacts.scope.\n` +
        `Add: "artifacts": { "backend": "fava-trails", "scope": "mwai/eng/project-name/codev-assets" }`
      );
    }
    return new FavaTrailsResolver(config.scope, workspaceRoot);
  }

  if (config?.backend && config.backend !== 'local') {
    throw new Error(
      `af-config.json has unknown artifacts.backend: "${config.backend}".\n` +
      `Valid values: "local" (default), "fava-trails"`
    );
  }

  return new LocalResolver(workspaceRoot);
}
