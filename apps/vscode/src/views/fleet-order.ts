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
    isCurrent: entry.workspace.path === currentPath,
  });

  const active = fleet.filter((e) => e.workspace.active).map(label);
  const dormant = fleet.filter((e) => !e.workspace.active).map(label);
  active.sort((a, b) => a.label.localeCompare(b.label));
  active.sort((a, b) => compareAttention(a.entry.attention, b.entry.attention));
  dormant.sort((a, b) => a.label.localeCompare(b.label));
  return { active, dormant };
}
