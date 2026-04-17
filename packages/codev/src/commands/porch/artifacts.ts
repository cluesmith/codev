/**
 * Artifact Resolver — pluggable backend for codev artifact access.
 *
 * Decouples porch from filesystem assumptions. Two backends:
 * - LocalResolver: reads from codev/specs/, codev/plans/ (default, backward compatible)
 * - CliResolver: shells out to a configurable CLI command (e.g. `my-tool get`)
 *
 * Spec 559: Porch Artifact Resolver
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { loadConfig } from '../../lib/config.js';

// =============================================================================
// Interface
// =============================================================================

export interface ArtifactResolver {
  /** Find spec basename by numeric ID (e.g., "0559-porch-artifact-resolver") */
  findSpecBaseName(projectId: string, title: string): string | null;

  /** Get full content of a spec by project ID */
  getSpecContent(projectId: string, title: string): string | null;

  /** Get full content of a plan by project ID */
  getPlanContent(projectId: string, title: string): string | null;

  /** Get full content of a review by project ID */
  getReviewContent(projectId: string, title: string): string | null;

  /** Check if a spec/plan has pre-approval frontmatter */
  hasPreApproval(artifactGlob: string): boolean;
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Check if artifact content has pre-approval frontmatter.
 * Looks for YAML frontmatter with `approved:` and `validated:` fields.
 * Used by both LocalResolver and CliResolver for consistency.
 */
export function isPreApprovedContent(content: string): boolean {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return false;

  const frontmatter = frontmatterMatch[1];
  const hasApproved = /^approved:\s*.+$/m.test(frontmatter);
  // Accept both inline YAML arrays (validated: [a, b]) and block YAML lists (validated:\n  - a)
  const hasValidated = /^validated:\s*(\[.+\]|$)/m.test(frontmatter);
  return hasApproved && hasValidated;
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

  getReviewContent(projectId: string, _title: string): string | null {
    const reviewsDir = path.join(this.workspaceRoot, 'codev', 'reviews');
    if (!fs.existsSync(reviewsDir)) return null;

    const normalizedId = projectId.replace(/^0+/, '') || '0';
    try {
      const files = fs.readdirSync(reviewsDir);
      const reviewFile = files.find(f => {
        if (!f.endsWith('.md')) return false;
        const numMatch = f.match(/^(\d+)/);
        if (!numMatch) return false;
        return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
      });
      if (reviewFile) {
        return fs.readFileSync(path.join(reviewsDir, reviewFile), 'utf-8');
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
      return isPreApprovedContent(content);
    } catch {
      return false;
    }
  }
}

// =============================================================================
// CLI Resolver (shells out to a configurable CLI command)
// =============================================================================

/** Sentinel value for cached negative results (CLI returned error) */
const NEGATIVE_CACHE = Symbol('negative');
type CacheEntry = string | typeof NEGATIVE_CACHE;

export class CliResolver implements ArtifactResolver {
  private cache = new Map<string, CacheEntry>();
  private extraEnv: Record<string, string>;

  constructor(
    private scope: string,
    private command: string,
    workspaceRoot?: string,
  ) {
    // Read data repo env vars from .env if not already in process.env.
    // af_builder.sh injects these into builder worktree .env files.
    this.extraEnv = {};
    const dataRepo = process.env.CODEV_ARTIFACTS_DATA_REPO;
    if (!dataRepo && workspaceRoot) {
      const envPath = path.join(workspaceRoot, '.env');
      try {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^CODEV_ARTIFACTS_DATA_REPO=(.+)$/m);
        if (match?.[1]?.trim()) {
          this.extraEnv.CODEV_ARTIFACTS_DATA_REPO = match[1].trim();
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

  getReviewContent(projectId: string, _title: string): string | null {
    const baseName = this.findReviewBaseName(projectId);
    if (!baseName) return null;
    return this.getContent(`reviews/${baseName}`);
  }

  hasPreApproval(artifactGlob: string): boolean {
    // Determine artifact type from glob path (e.g., "codev/specs/0559-*.md" or "codev/plans/0559-*.md")
    const typeMatch = artifactGlob.match(/\b(specs|plans|reviews)\b/);
    const idMatch = artifactGlob.match(/(?:specs|plans|reviews)\/0*(\d+)/);
    if (!idMatch) return false;

    const projectId = idMatch[1];
    let content: string | null = null;
    const artifactType = typeMatch?.[1] || 'specs';

    if (artifactType === 'plans') {
      content = this.getPlanContent(projectId, '');
    } else if (artifactType === 'reviews') {
      content = this.getReviewContent(projectId, '');
    } else {
      content = this.getSpecContent(projectId, '');
    }

    if (!content) return false;
    return isPreApprovedContent(content);
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

  private findReviewBaseName(projectId: string): string | null {
    const children = this.listChildren('reviews');
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
      const cached = this.cache.get(cacheKey)!;
      if (cached === NEGATIVE_CACHE) return null;
      const items = cached.split('\n').filter(Boolean);
      return items.length > 0 ? items : null;
    }

    const scopePath = `${this.scope}/${subPath}`;
    try {
      const output = execFileSync(this.command, ['get', '--list', scopePath], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ...this.extraEnv },
      }).trim();
      // Cache both non-empty and empty results (empty = scope exists but has no children)
      this.cache.set(cacheKey, output);
      const items = output ? output.split('\n').filter(Boolean) : [];
      return items.length > 0 ? items : null;
    } catch (err: unknown) {
      this.handleError(err, scopePath);
      // Cache failures as negative to avoid repeated CLI timeouts
      this.cache.set(cacheKey, NEGATIVE_CACHE);
      return null;
    }
  }

  private getContent(subPath: string): string | null {
    const cacheKey = `content:${subPath}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      return cached === NEGATIVE_CACHE ? null : cached;
    }

    const scopePath = `${this.scope}/${subPath}`;
    try {
      const output = execFileSync(this.command, ['get', scopePath], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, ...this.extraEnv },
      });
      this.cache.set(cacheKey, output);
      return output;
    } catch (err: unknown) {
      this.handleError(err, scopePath);
      // Cache failures as negative to avoid repeated CLI timeouts
      this.cache.set(cacheKey, NEGATIVE_CACHE);
      return null;
    }
  }

  private handleError(err: unknown, scopePath: string): void {
    if (err && typeof err === 'object' && 'code' in err) {
      if ((err as { code: string }).code === 'ENOENT') {
        throw new Error(
          `CLI command '${this.command}' not found. Ensure it is installed and on PATH.`
        );
      }
    }
    // Non-zero exit — log warning for debugging
    if (err && typeof err === 'object' && 'stderr' in err) {
      const stderr = (err as { stderr: string }).stderr;
      if (stderr) {
        console.error(`[porch] ${this.command} get ${scopePath}: ${stderr.trim()}`);
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create the appropriate artifact resolver for this workspace.
 * Reads config via loadConfig() (v3.0.0 unified config — .codev/config.json).
 *
 * @param workspaceRoot - The top-level workspace (where .codev/config.json lives).
 *                        Always used to load config; also used as the .env source
 *                        for the CLI backend.
 * @param artifactRoot - Optional override for where the local backend reads
 *                        specs/plans/reviews from. When the project lives in a
 *                        builder worktree (`.builders/<slug>/`), pass that
 *                        worktree's root so artifact lookups find files there
 *                        instead of the top-level `codev/` directory (bugfix #676).
 *                        Defaults to workspaceRoot.
 */
export function getResolver(workspaceRoot: string, artifactRoot?: string): ArtifactResolver {
  const config = loadConfig(workspaceRoot);
  const artifacts = config.artifacts;

  if (artifacts?.backend === 'cli') {
    if (!artifacts.command) {
      throw new Error(
        `.codev/config.json has artifacts.backend: "cli" but no artifacts.command.\n` +
        `Add: "artifacts": { "backend": "cli", "command": "my-tool", "scope": "org/project" }`
      );
    }
    if (!artifacts.scope) {
      throw new Error(
        `.codev/config.json has artifacts.backend: "cli" but no artifacts.scope.\n` +
        `Add: "artifacts": { "backend": "cli", "command": "${artifacts.command}", "scope": "org/project" }`
      );
    }
    return new CliResolver(artifacts.scope, artifacts.command, workspaceRoot);
  }

  if (artifacts?.backend && artifacts.backend !== 'local') {
    throw new Error(
      `.codev/config.json has unknown artifacts.backend: "${artifacts.backend}".\n` +
      `Valid values: "local" (default), "cli"`
    );
  }

  return new LocalResolver(artifactRoot ?? workspaceRoot);
}
