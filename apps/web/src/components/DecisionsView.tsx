import { DecisionsView as SharedDecisionsView } from '@cluesmith/codev-workspace-views';
import { dashboardDecisionsHost } from '../lib/decisionsHost.js';

interface DecisionsViewProps {
  isActive: boolean;
}

/**
 * Spec 1819: the Decisions tab — the shared Decisions view (Spec 1963,
 * @cluesmith/codev-workspace-views) with the dashboard as its host. Stays mounted while the tab
 * exists (App.tsx), so its state — the drafts with it — survives tab switches.
 */
export function DecisionsView({ isActive }: DecisionsViewProps) {
  return <SharedDecisionsView host={dashboardDecisionsHost} isActive={isActive} />;
}
