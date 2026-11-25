/**
 * Dashboard issue-id helpers (#1740). `issueRef` and the canonical key grammar live with the Work
 * view in @cluesmith/codev-workspace-views; this is the dashboard's own tab logic.
 */

import type { Builder, OverviewBuilder } from './api.js';

/**
 * The terminal tab for an overview builder. The overview's `roleId` is the
 * terminal's id, so an exact (case-insensitive) match comes first. The older
 * substring match is the fallback for a Tower that sends no roleId; it compares
 * case-insensitively because terminal ids are lower-case while tracker keys
 * arrive upper-case (`ENG-123` vs `builder-pir-eng-123`).
 */
export function findBuilderTab(builder: OverviewBuilder, tabs: Builder[] | undefined): Builder | undefined {
  if (!tabs) { return undefined; }
  const role = builder.roleId?.toLowerCase();
  if (role) {
    const exact = tabs.find(t => t.id?.toLowerCase() === role);
    if (exact) { return exact; }
  }
  const needle = (builder.issueId ?? builder.id).toLowerCase();
  return tabs.find(t => t.name?.toLowerCase().includes(needle) || t.id?.toLowerCase().includes(needle));
}
