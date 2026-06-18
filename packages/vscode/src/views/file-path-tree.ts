/**
 * Group a flat list of changed files into a nested folder tree, with
 * VSCode SCM-style compaction: any folder with exactly one child folder
 * gets merged into that child's path, so `packages/codev/src` renders
 * as a single row instead of three nested folders.
 *
 * Pure path manipulation — no VSCode dependency, easy to unit-test.
 * The leaf node carries the original `BuilderFileChange` verbatim so
 * the renderer can build `BuilderFileTreeItem` instances unchanged
 * (including renames, status badges, etc.).
 */

import type { BuilderFileChange } from './builder-diff-cache.js';

/**
 * One node in the file-path tree. Folder nodes have `children`; leaf
 * (file) nodes have `file`. The two are mutually exclusive in practice
 * but the shape doesn't enforce it — the renderer branches on which
 * field is present.
 *
 * `name` is the *display* label (may be compacted, e.g.
 * `packages/codev/src`). `fullPath` is the canonical relative path
 * from the worktree root; used as a stable id so VSCode persists
 * folder-expansion state across overview-poll refreshes.
 */
export interface FilePathNode {
  name: string;
  fullPath: string;
  file?: BuilderFileChange;
  children?: FilePathNode[];
}

/**
 * Build a folder-tree representation of the given files, then apply
 * single-child-folder compaction. Returns the top-level nodes
 * (folders or root-level files), sorted folders-first / alphabetical
 * within each group.
 */
export function buildFilePathTree(files: BuilderFileChange[]): FilePathNode[] {
  // Walk each file's path into a mutable nested structure. Folder nodes
  // get an internal `_kids` map keyed by segment name so we can merge
  // siblings as we go; the final shape drops it in favour of
  // `children: FilePathNode[]`.
  interface Mutable {
    name: string;
    fullPath: string;
    file?: BuilderFileChange;
    _kids?: Map<string, Mutable>;
  }

  const root: Mutable = { name: '', fullPath: '', _kids: new Map() };
  for (const f of files) {
    const segments = f.plan.resourcePath.split('/').filter(s => s.length > 0);
    let cursor = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLeaf = i === segments.length - 1;
      const parentPath = cursor.fullPath;
      const childPath = parentPath ? `${parentPath}/${seg}` : seg;
      if (!cursor._kids) { cursor._kids = new Map(); }
      let next = cursor._kids.get(seg);
      if (!next) {
        next = { name: seg, fullPath: childPath };
        cursor._kids.set(seg, next);
      }
      if (isLeaf) {
        next.file = f;
      }
      cursor = next;
    }
  }

  // Convert the mutable structure to FilePathNode, sort, and compact.
  const convert = (m: Mutable): FilePathNode => {
    const kids = m._kids ? [...m._kids.values()].map(convert) : undefined;
    return {
      name: m.name,
      fullPath: m.fullPath,
      ...(m.file ? { file: m.file } : {}),
      ...(kids && kids.length > 0 ? { children: kids } : {}),
    };
  };
  const compactAndSort = (node: FilePathNode): FilePathNode => {
    if (!node.children) { return node; }
    // Single-child compaction: collapse only when the lone child is
    // itself a folder. A folder with a single *file* child stays as
    // two rows — that matches VSCode SCM (the file is the meaningful
    // leaf and shouldn't merge into its parent).
    let compacted: FilePathNode = node;
    while (
      compacted.children &&
      compacted.children.length === 1 &&
      compacted.children[0]!.children !== undefined
    ) {
      const only = compacted.children[0]!;
      compacted = {
        name: `${compacted.name}/${only.name}`,
        fullPath: only.fullPath,
        children: only.children,
      };
    }
    // Recurse, then sort: folders before files, alphabetical within.
    compacted = {
      ...compacted,
      children: compacted.children!.map(compactAndSort).sort(compareNodes),
    };
    return compacted;
  };

  const topLevel = root._kids
    ? [...root._kids.values()].map(convert).map(compactAndSort)
    : [];
  return topLevel.sort(compareNodes);
}

/**
 * Flatten a built file-path tree to its leaf files in **display order** — the
 * depth-first walk VSCode renders: a folder's entire subtree before its next
 * sibling, folders before loose files within each level (the order
 * `buildFilePathTree` already sorted into). Used by cross-file navigation
 * (#1060) so stepping matches the visual tree in tree-view mode, rather than the
 * raw git `--name-status` order (#1066 review feedback).
 */
export function flattenTreeOrder(nodes: FilePathNode[]): BuilderFileChange[] {
  const out: BuilderFileChange[] = [];
  for (const node of nodes) {
    if (node.children) {
      out.push(...flattenTreeOrder(node.children));
    } else if (node.file) {
      out.push(node.file);
    }
  }
  return out;
}

/** Folders before files; alphabetical (case-insensitive) within each group. */
function compareNodes(a: FilePathNode, b: FilePathNode): number {
  const aIsFolder = a.children !== undefined;
  const bIsFolder = b.children !== undefined;
  if (aIsFolder !== bIsFolder) { return aIsFolder ? -1 : 1; }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
