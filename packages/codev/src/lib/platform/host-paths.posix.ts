/**
 * Host paths on macOS and Linux (Spec 1658, Amendment 2, phase A2-2).
 *
 * Each method is the POSIX branch its call site used to carry, moved verbatim.
 * See `host-paths.ts` for the contract. Leaf module: node builtins only.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { HostPaths } from './host-paths.js';

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isUnder(candidate: string, dir: string): boolean {
  return candidate.startsWith(dir + '/');
}

export const posixHostPaths: HostPaths = Object.freeze<HostPaths>({
  canonicalize(workspacePath, ops) {
    try {
      return ops.realpath(workspacePath);
    } catch {
      // Path doesn't exist yet — normalize without realpath.
      return path.resolve(workspacePath);
    }
  },

  key(workspacePath) {
    // The path exactly as given (unchanged behaviour; see #1870).
    return workspacePath;
  },

  expandHome(input, home) {
    if (input === '~') {
      return home;
    }
    if (input.startsWith('~/')) {
      return home + input.slice(1);
    }
    return input;
  },

  endsWithSeparator(input) {
    return input.endsWith('/');
  },

  lastSegment(input) {
    return input.split('/').pop() ?? '';
  },

  isUnder,

  isAtOrUnder(candidate, dir) {
    return candidate === dir || isUnder(candidate, dir);
  },

  toForwardSlashes(p) {
    return p;
  },

  splitBuilderWorktree(p) {
    const match = p.match(/^(.+)\/\.builders\/([^/]+)/);
    if (!match) return null;
    return { workspacePath: match[1], worktreeDirName: match[2] };
  },

  hasBuildersSegment(p) {
    return p.includes('/.builders/');
  },

  lastBuildersMarkerIndex(p) {
    return p.lastIndexOf('/.builders/');
  },

  workspaceOfBuilderCwd(cwd) {
    const builderMatch = cwd.match(/^(.+)\/.builders\/[^/]+$/);
    if (builderMatch) {
      return builderMatch[1];
    }
    return null;
  },

  isAbsoluteBuilderWorktree(value) {
    return /^\/.+\/\.builders\/[^/]+/.test(value);
  },

  sameDirectory(a, b) {
    const wanted = new Set([b, realpathOrSelf(b)]);
    const got = new Set([a, realpathOrSelf(a)]);
    return [...got].some((g) => wanted.has(g));
  },

  canonicalFilePath(raw) {
    try {
      return realpathSync(raw);
    } catch {
      try {
        return path.join(realpathSync(path.dirname(raw)), path.basename(raw));
      } catch {
        return path.resolve(raw);
      }
    }
  },
});
