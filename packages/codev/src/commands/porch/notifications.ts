/**
 * Porch Notifications
 *
 * Simple notification system for porch events.
 * Supports console logging and optional desktop notifications.
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { ProjectState, ConsultationFeedback } from './types.js';

/**
 * Notification event types
 */
export type NotificationEvent =
  | 'phase-start'
  | 'phase-complete'
  | 'gate-pending'
  | 'gate-approved'
  | 'consultation-start'
  | 'consultation-complete'
  | 'check-failed'
  | 'blocked'
  | 'error';

/**
 * Notification payload
 */
export interface NotificationPayload {
  event: NotificationEvent;
  projectId: string;
  phase?: string;
  message: string;
  details?: string;
}

/**
 * Send a desktop notification (macOS only)
 * Fails silently if osascript is not available
 */
async function sendDesktopNotification(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  return new Promise((resolve) => {
    const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
    const proc = spawn('osascript', ['-e', script], { stdio: 'ignore' });

    proc.on('close', () => resolve());
    proc.on('error', () => resolve());

    // Don't wait forever
    setTimeout(() => resolve(), 2000);
  });
}

/**
 * Format and log a notification to console
 */
function logNotification(payload: NotificationPayload): void {
  const { event, projectId, phase, message, details } = payload;

  let icon: string;
  let color: typeof chalk.green;

  switch (event) {
    case 'phase-start':
      icon = '>';
      color = chalk.blue;
      break;
    case 'phase-complete':
      icon = '✓';
      color = chalk.green;
      break;
    case 'gate-pending':
      icon = '◉';
      color = chalk.yellow;
      break;
    case 'gate-approved':
      icon = '✓';
      color = chalk.green;
      break;
    case 'consultation-start':
      icon = '⟳';
      color = chalk.blue;
      break;
    case 'consultation-complete':
      icon = '✓';
      color = chalk.green;
      break;
    case 'check-failed':
      icon = '✗';
      color = chalk.red;
      break;
    case 'blocked':
      icon = '!';
      color = chalk.yellow;
      break;
    case 'error':
      icon = '✗';
      color = chalk.red;
      break;
    default:
      icon = '•';
      color = chalk.gray;
  }

  const prefix = phase
    ? `[porch:${projectId}:${phase}]`
    : `[porch:${projectId}]`;

  console.log(color(`${icon} ${prefix} ${message}`));

  if (details) {
    console.log(chalk.gray(`  ${details}`));
  }
}

/**
 * Send a notification
 */
export async function notify(
  payload: NotificationPayload,
  options: { desktop?: boolean } = {}
): Promise<void> {
  // Always log to console
  logNotification(payload);

  // Desktop notification for important events
  if (options.desktop) {
    const shouldNotify =
      payload.event === 'gate-pending' ||
      payload.event === 'consultation-complete' ||
      payload.event === 'check-failed' ||
      payload.event === 'blocked' ||
      payload.event === 'error';

    if (shouldNotify) {
      const title = `Porch: ${payload.projectId}`;
      await sendDesktopNotification(title, payload.message);
    }
  }
}

/**
 * Notify phase start
 */
export async function notifyPhaseStart(
  projectId: string,
  phase: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'phase-start',
      projectId,
      phase,
      message: `Starting phase: ${phase}`,
    },
    options
  );
}

/**
 * Notify phase complete
 */
export async function notifyPhaseComplete(
  projectId: string,
  phase: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'phase-complete',
      projectId,
      phase,
      message: `Completed phase: ${phase}`,
    },
    options
  );
}

/**
 * Notify gate pending approval
 */
export async function notifyGatePending(
  projectId: string,
  phase: string,
  gateName: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'gate-pending',
      projectId,
      phase,
      message: `Gate pending: ${gateName}`,
      details: `Run: porch approve ${projectId} ${gateName}`,
    },
    options
  );
}

/**
 * Notify gate approved
 */
export async function notifyGateApproved(
  projectId: string,
  gateName: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'gate-approved',
      projectId,
      message: `Gate approved: ${gateName}`,
    },
    options
  );
}

/**
 * Notify consultation start
 */
export async function notifyConsultationStart(
  projectId: string,
  phase: string,
  models: string[],
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'consultation-start',
      projectId,
      phase,
      message: `Starting ${models.length}-way consultation`,
      details: `Models: ${models.join(', ')}`,
    },
    options
  );
}

/**
 * Notify consultation complete
 */
export async function notifyConsultationComplete(
  projectId: string,
  phase: string,
  feedback: ConsultationFeedback[],
  allApproved: boolean,
  options: { desktop?: boolean } = {}
): Promise<void> {
  const approveCount = feedback.filter((f) => f.verdict === 'APPROVE').length;
  const changeCount = feedback.filter((f) => f.verdict === 'REQUEST_CHANGES').length;

  const message = allApproved
    ? `Consultation complete: All ${approveCount} models approved`
    : `Consultation complete: ${approveCount} approved, ${changeCount} requested changes`;

  await notify(
    {
      event: 'consultation-complete',
      projectId,
      phase,
      message,
      details: feedback.map((f) => `${f.model}: ${f.verdict}`).join(', '),
    },
    options
  );
}

/**
 * Notify check failed
 */
export async function notifyCheckFailed(
  projectId: string,
  phase: string,
  checkName: string,
  error: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'check-failed',
      projectId,
      phase,
      message: `Check failed: ${checkName}`,
      details: error,
    },
    options
  );
}

/**
 * Notify blocked
 */
export async function notifyBlocked(
  projectId: string,
  reason: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'blocked',
      projectId,
      message: `Blocked: ${reason}`,
    },
    options
  );
}

/**
 * Notify error
 */
export async function notifyError(
  projectId: string,
  error: string,
  options: { desktop?: boolean } = {}
): Promise<void> {
  await notify(
    {
      event: 'error',
      projectId,
      message: `Error: ${error}`,
    },
    options
  );
}

/**
 * Create a notification context for a project
 * Returns bound notification functions
 */
export function createNotifier(projectId: string, options: { desktop?: boolean } = {}) {
  return {
    phaseStart: (phase: string) => notifyPhaseStart(projectId, phase, options),
    phaseComplete: (phase: string) => notifyPhaseComplete(projectId, phase, options),
    gatePending: (phase: string, gateName: string) =>
      notifyGatePending(projectId, phase, gateName, options),
    gateApproved: (gateName: string) => notifyGateApproved(projectId, gateName, options),
    consultationStart: (phase: string, models: string[]) =>
      notifyConsultationStart(projectId, phase, models, options),
    consultationComplete: (
      phase: string,
      feedback: ConsultationFeedback[],
      allApproved: boolean
    ) => notifyConsultationComplete(projectId, phase, feedback, allApproved, options),
    checkFailed: (phase: string, checkName: string, error: string) =>
      notifyCheckFailed(projectId, phase, checkName, error, options),
    blocked: (reason: string) => notifyBlocked(projectId, reason, options),
    error: (error: string) => notifyError(projectId, error, options),
  };
}
