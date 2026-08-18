import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import { VSCODE_USER_SENDER } from '@cluesmith/codev-types';
import type { TowerClient } from '@cluesmith/codev-sdk/tower-client';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';

const execFileAsync = promisify(execFile);

/**
 * #1494: the Approve button relays the human's decision to the builder's
 * spawning architect, instead of the extension shelling out to `porch approve`
 * itself. This mirrors how humans already work with codev — they tell the
 * architect a gate was approved, and the architect passes it on to the builder,
 * who runs the command — and keeps the architect in the loop so its model of the
 * builder doesn't go stale between gates.
 *
 * `decideApprovalRelay` is the pure routing core: given the builder's owning
 * architect and the workspace's *live* architects, it decides where (or whether)
 * the decision goes. It is deliberately free of `vscode`/Tower so the four
 * branches are unit-testable without a running Tower.
 *
 * The `owner` input is `OverviewBuilder.spawnedByArchitect`. `liveArchitectNames`
 * is `OverviewData.architects.map(a => a.name)` — which reports LIVENESS, not
 * registration (Tower skips architects with no live session), so an empty list
 * means "no architect is live right now", NOT "this is a CLI-only workspace".
 * That distinction is why the last branch is named `no-live-architect` and
 * announces only what liveness can support.
 *
 * We must NOT fold a null owner into `main` the way `builder-grouping.ts` does
 * for display (#1406): a misrouted status line is noise, but a misrouted
 * *approval* sends a human's gate decision to an architect that did not spawn
 * the builder.
 */
export type ApprovalRelayDecision =
  /** Owner is set and live — relay the decision to `architect:<architect>`. */
  | { kind: 'relay'; architect: string }
  /** Owner is set but not live — refuse rather than reroute to a different architect. */
  | { kind: 'refuse-offline'; architect: string }
  /** Owner unknown but other architects are live — refuse rather than guess which one. */
  | { kind: 'refuse-unknown-owner' }
  /** No architect is live — announce that and approve directly (nobody to relay to). */
  | { kind: 'no-live-architect' };

export function decideApprovalRelay(
  owner: string | null,
  liveArchitectNames: string[],
): ApprovalRelayDecision {
  if (owner) {
    if (liveArchitectNames.includes(owner)) {
      return { kind: 'relay', architect: owner };
    }
    return { kind: 'refuse-offline', architect: owner };
  }
  if (liveArchitectNames.length > 0) {
    return { kind: 'refuse-unknown-owner' };
  }
  return { kind: 'no-live-architect' };
}

/**
 * The relay message body: a short, human-style instruction to the architect,
 * phrased the way a person would ("Approve ..., please pass it to the builder"),
 * not a passive "X was approved" notice. The imperative framing matters: a
 * past-tense fact reads as "already done", so the architect never relays it and
 * the builder stalls. The "please pass it to the builder" cue is load-bearing: it
 * routes execution to the builder (builder-runs-it) rather than the architect
 * running `porch approve` itself. It deliberately does not name `porch` or a
 * command: the builder's own prompt covers running it once relayed. Provenance
 * (a human clicked in VS Code) is carried by the `[USER via VS Code]` header Tower
 * renders from the `VSCODE_USER_SENDER` `from`, not by text in the body.
 *
 * `id` is the builder handle the architect routes to; `issueId` is appended only
 * when the id doesn't already carry it, so a builder whose id is the issue number
 * (e.g. `158`, issue `#158`) doesn't render the number twice.
 */
export function buildRelayMessage(args: {
  id: string;
  gateLabel: string;
  issueId?: string | null;
}): string {
  const { id, gateLabel, issueId } = args;
  const issuePart = issueId && !id.includes(issueId) ? ` (#${issueId})` : '';
  return `Approve the ${gateLabel} gate for ${id}${issuePart}, please pass it to the builder.`;
}

/** Result shape returned by `TowerClient.sendMessage` (Spec 1313 mailbox-first). */
type SendResult = { ok: boolean; delivered?: boolean; held?: boolean; reason?: string; error?: string };

/**
 * How the send result is surfaced to the human who clicked. The click does not
 * *approve* — it hands the decision to the architect, who passes it to the
 * builder — so the wording is "sent / held / failed", never "approved". The
 * `held` case is first-class: on a held relay the approval has NOT happened, and
 * a UI that reports success there is a defect (#1494).
 */
export type RelayOutcome =
  | { kind: 'error'; message: string }
  | { kind: 'held'; message: string }
  | { kind: 'relayed'; message: string };

export function interpretRelayResult(
  result: SendResult,
  architect: string,
  gateLabel: string,
  issueRef: string,
): RelayOutcome {
  if (!result.ok) {
    return {
      kind: 'error',
      message: `Codev: couldn't reach architect ${architect} — ${result.error ?? 'unknown error'}. The gate is NOT approved.`,
    };
  }
  // `held` is only set by Spec-1313 Tower binaries; older binaries omit it, and a
  // bare `{ ok }` then reads as delivered — preserving prior behavior.
  if (result.held) {
    const reason = result.reason ? ` (${result.reason})` : '';
    return {
      kind: 'held',
      message: `Codev: sent to ${architect} but held${reason} — it will reach them when their prompt is clear. The ${gateLabel} gate (${issueRef}) is NOT approved yet.`,
    };
  }
  return {
    kind: 'relayed',
    message: `Codev: sent the ${gateLabel} approval to ${architect} (${issueRef}) — they'll pass it on to the builder.`,
  };
}

/**
 * Per-gate side-button mapping for the approval-confirmation dialog.
 *
 * Lets the reviewer pop open the natural artifact for one final look
 * before committing to approval — without first dismissing the dialog
 * and re-triggering the command.
 *
 * Mirrors `gate-toast.ts`'s GATE_ACTIONS one-for-one so a given gate
 * surfaces the same inspection action from either entry point. The maps
 * are kept in separate files because the two surfaces have different
 * ergonomics (toast at gate-pending fires once; this confirmation fires
 * every approval click), but their *contents* must stay in sync.
 */
const GATE_SIDE_ACTIONS: Record<string, { label: string; command: string }> = {
  'plan-approval': { label: 'View Plan', command: 'codev.viewPlanFile' },
  'dev-approval':  { label: 'Run Dev',   command: 'codev.runWorktreeDev' },
};

export interface ApproveGateOptions {
  /**
   * When true, skip the confirmation dialog and approve directly. Used
   * by the gate-pending toast (gate-toast.ts), which is itself the
   * context — surfacing a second confirmation would be redundant.
   */
  skipConfirmation?: boolean;
}

/**
 * Codev: Approve Gate.
 *
 * Three invocation paths:
 *
 *   1. Right-click a blocked-builder row → pass the builder ID directly.
 *      Skips the quick-pick; auto-detects the gate from b.blockedGate.
 *      Shows the rich confirmation dialog.
 *
 *   2. Command palette / Cmd+K G → no builder ID → show quick-pick of all
 *      blocked builders. Then the rich confirmation dialog.
 *
 *   3. Gate-pending toast's [Approve] button → builder ID + options
 *      { skipConfirmation: true }. The toast was the context; approving
 *      from there commits directly with no second confirmation.
 *
 * After `porch approve` succeeds, refresh the OverviewCache so the
 * sidebar updates immediately rather than waiting for the SSE round-trip
 * triggered by porch's overview-refresh broadcast.
 */
export async function approveGate(
  connectionManager: ConnectionManager,
  cache?: OverviewCache,
  builderIdArg?: string,
  options?: ApproveGateOptions,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const overview = await client.getOverview(workspacePath);
  const blocked = overview?.builders?.filter(b => b.blocked) ?? [];
  if (blocked.length === 0) {
    vscode.window.showInformationMessage('Codev: No blocked builders');
    return;
  }

  // We need blockedGate (canonical name like "plan-approval"), not blocked
  // (display label like "plan review"). Porch's gate keys are the canonical
  // names; the display label is for the human-facing prompts.
  let builder: typeof blocked[number] | undefined;
  let gate: string;
  if (builderIdArg) {
    builder = blocked.find(b => b.id === builderIdArg);
    if (!builder || !builder.blockedGate) {
      vscode.window.showWarningMessage(`Codev: Builder ${builderIdArg} is not blocked at a gate`);
      return;
    }
    gate = builder.blockedGate;
  } else {
    const candidates = blocked.filter(b => b.blockedGate);
    const picked = await vscode.window.showQuickPick(
      candidates.map(b => ({
        label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
        description: `blocked on ${b.blocked}`,
        builder: b,
        gate: b.blockedGate!,
      })),
      { placeHolder: 'Select gate to approve' },
    );
    if (!picked) { return; }
    builder = picked.builder;
    gate = picked.gate;
  }

  const id = builder.id;
  const issueRef = builder.issueId ? `#${builder.issueId}` : id;
  const titlePart = builder.issueTitle ? ` — ${truncate(builder.issueTitle, 60)}` : '';
  // Display label e.g. "plan review" from overview; falls back to the
  // canonical gate name if the display label isn't set.
  const gateLabel = builder.blocked ?? gate;

  // #1494: the workspace's *live* architects (Tower skips dead registrations).
  // Reused from the overview we already fetched — no extra round-trip.
  const liveArchitects = (overview?.architects ?? []).map(a => a.name);

  // Fast path: caller already has context (gate-pending toast). Skip the
  // confirmation dialog and go straight to the relay decision.
  if (options?.skipConfirmation) {
    await relayApproval(client, workspacePath, builder, liveArchitects, gate, gateLabel, issueRef);
    cache?.refresh();
    return;
  }

  // Rich confirmation: modal (centered, blocking) keeps the dialog close
  // to where the user just clicked — the ✓ icon in the left sidebar or
  // Cmd+K G near the editor — instead of a bottom-right toast that
  // forces a diagonal cursor traversal. Approval is a deliberate,
  // once-per-gate action; the modal interrupt is appropriate.
  const sideAction = GATE_SIDE_ACTIONS[gate];
  const buttons = sideAction ? [sideAction.label, 'Approve'] : ['Approve'];

  const selection = await vscode.window.showInformationMessage(
    `Approve ${gateLabel} for ${issueRef}${titlePart}?`,
    { modal: true },
    ...buttons,
  );

  if (!selection) { return; }

  if (selection === 'Approve') {
    await relayApproval(client, workspacePath, builder, liveArchitects, gate, gateLabel, issueRef);
    cache?.refresh();
    return;
  }

  // Side-button clicked. Invoke the corresponding command with the
  // builder ID; the user can re-trigger Approve afterward.
  if (sideAction && selection === sideAction.label) {
    await vscode.commands.executeCommand(sideAction.command, id);
  }
}

/**
 * Route the human's approval to the builder's spawning architect (#1494).
 *
 * Four outcomes (see `decideApprovalRelay`):
 *  - relay             → send the decision to `architect:<owner>`; report relayed / held / failed.
 *  - refuse-offline    → the owning architect is down; refuse (don't reroute — #1406) with a modal.
 *  - refuse-unknown-owner → owner unknown but architects are live; refuse rather than guess.
 *  - no-live-architect → nobody to relay to; announce that and approve directly.
 */
async function relayApproval(
  client: TowerClient,
  workspacePath: string,
  builder: OverviewBuilder,
  liveArchitectNames: string[],
  gate: string,
  gateLabel: string,
  issueRef: string,
): Promise<void> {
  const decision = decideApprovalRelay(builder.spawnedByArchitect ?? null, liveArchitectNames);

  switch (decision.kind) {
    case 'relay': {
      const message = buildRelayMessage({
        id: builder.id,
        gateLabel,
        issueId: builder.issueId,
      });
      let result: SendResult;
      try {
        result = await client.sendMessage(`architect:${decision.architect}`, message, {
          workspace: workspacePath,
          from: VSCODE_USER_SENDER,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Codev: relay to architect ${decision.architect} failed — ${msg}. The gate is NOT approved.`,
        );
        return;
      }
      const outcome = interpretRelayResult(result, decision.architect, gateLabel, issueRef);
      switch (outcome.kind) {
        case 'error':   vscode.window.showErrorMessage(outcome.message); break;
        case 'held':    vscode.window.showWarningMessage(outcome.message); break;
        case 'relayed': vscode.window.showInformationMessage(outcome.message); break;
      }
      return;
    }
    case 'refuse-offline':
      vscode.window.showErrorMessage(
        `Codev: architect "${decision.architect}" spawned ${builder.id} but is not running, so the approval can't be relayed to it. ` +
          `Start it (afx workspace start) or approve from a shell with porch approve. The gate is NOT approved.`,
        { modal: true },
      );
      return;
    case 'refuse-unknown-owner':
      vscode.window.showErrorMessage(
        `Codev: ${builder.id} has no recorded spawning architect and there are live architects — refusing to guess which should receive the approval. ` +
          `Approve from a shell with porch approve. The gate is NOT approved.`,
        { modal: true },
      );
      return;
    case 'no-live-architect':
      await approveDirectlyNoLiveArchitect(workspacePath, builder.id, gate, gateLabel, issueRef);
      return;
  }
}

/**
 * The `no-live-architect` fallback: there is no live architect to relay to, so
 * the extension runs `porch approve` directly. The announcement states only what
 * liveness can support ("no live architect … no architect was notified") — never
 * "no architect registered", because `overview.architects` reports liveness, not
 * registration (#1494 route-to-main item 2, option b). Retained only for this
 * branch; the architect-present paths never reach it.
 */
async function approveDirectlyNoLiveArchitect(
  workspacePath: string,
  id: string,
  gate: string,
  gateLabel: string,
  issueRef: string,
): Promise<void> {
  try {
    await execFileAsync('porch', [
      'approve',
      id,
      gate,
      '--a-human-explicitly-approved-this',
    ], { cwd: workspacePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Codev: porch approve failed — ${msg}`);
    return;
  }
  vscode.window.showWarningMessage(
    `Codev: no live architect in this workspace — approved ${gateLabel} for ${issueRef} directly. No architect was notified of this approval.`,
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
