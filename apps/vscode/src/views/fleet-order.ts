import { compareAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { FleetEntry } from './tower-cache.js';
import { disambiguateLabels } from './workspace-label.js';

/** A fleet entry resolved for display: its disambiguated label and whether it's this window's own. */
export interface LabelledEntry {
  entry: FleetEntry;
  label: string;
  isCurrent: boolean;
}

/** Active workspaces (urgency-ordered) and dormant workspaces (label order), labelled once. */
export interface OrderedFleet {
  active: LabelledEntry[];
  dormant: LabelledEntry[];
}

/**
 * Whether Tower's path for a workspace is this window's folder. On Windows paths
 * are case-insensitive and the two sides spell them differently: VS Code's
 * `uri.fsPath` lower-cases the drive letter, while Tower reports the directory's
 * canonical spelling with an upper-case drive (Spec 1658, finding M6). POSIX
 * keeps the exact comparison.
 */
export function isSameWorkspacePath(towerPath: string, currentPath: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (currentPath === null) {
    return false;
  }
  if (platform === 'win32') {
    return towerPath.toLowerCase() === currentPath.toLowerCase();
  }
  return towerPath === currentPath;
}

/**
 * The single ordering the Tower tree and the switch quick-pick both use, so the two surfaces can
 * never disagree on order. Labels are disambiguated once; active workspaces are sorted by label and
 * then by `compareAttention` with a **stable** sort — so "needs a human" floats up while
 * equal-attention workspaces keep label order (the tie-break the comparator leaves to callers).
 * Dormant workspaces are a label-ordered secondary group.
 */
export function orderFleet(fleet: ReadonlyArray<FleetEntry>, currentPath: string | null): OrderedFleet {
  const labels = disambiguateLabels(fleet.map((e) => e.workspace));
  const label = (entry: FleetEntry): LabelledEntry => ({
    entry,
    label: labels.get(entry.workspace.path) ?? entry.workspace.name,
    isCurrent: isSameWorkspacePath(entry.workspace.path, currentPath),
  });

  const active = fleet.filter((e) => e.workspace.active).map(label);
  const dormant = fleet.filter((e) => !e.workspace.active).map(label);
  active.sort((a, b) => a.label.localeCompare(b.label));
  active.sort((a, b) => compareAttention(a.entry.attention, b.entry.attention));
  dormant.sort((a, b) => a.label.localeCompare(b.label));
  return { active, dormant };
}
