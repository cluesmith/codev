/**
 * Push notification utilities for porch events.
 * Sends notifications to the tower dashboard for real-time updates.
 */

import path from 'node:path';
import { getTowerClient } from '../lib/tower-client.js';
import { isWindows } from '../../lib/platform.js';

export type NotificationType = 'gate' | 'blocked' | 'error' | 'info';

interface NotificationPayload {
  type: NotificationType;
  workspacePath: string;
  projectId: string;
  details: string;
}

// Track sent notifications to avoid duplicates within short window
const recentNotifications = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60000; // 1 minute

function isDuplicate(key: string): boolean {
  const lastSent = recentNotifications.get(key);
  if (lastSent && Date.now() - lastSent < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentNotifications.set(key, Date.now());
  return false;
}

/**
 * Get canonical workspace path from worktree path.
 * Builder worktrees are at: <workspace>/.builders/<id>/<branch>
 * Porch runs in these worktrees but notifications need the canonical path.
 */
function getCanonicalWorkspacePath(cwd: string): string {
  let builderMatch: RegExpMatchArray | null;
  if (isWindows()) {
    // A native Windows cwd separates with `\` (or a mix).
    builderMatch = cwd.match(/^(.+)[\\/].builders[\\/][^\\/]+$/);
  } else {
    builderMatch = cwd.match(/^(.+)\/.builders\/[^/]+$/);
  }
  if (builderMatch) {
    return builderMatch[1]; // Return canonical workspace root
  }
  return cwd;
}

/**
 * Send a push notification to the tower dashboard.
 * Notifications are delivered via SSE to connected browsers.
 */
export async function sendPushNotification(payload: NotificationPayload): Promise<void> {
  // Dedupe by workspace + type + details
  const dedupeKey = `${payload.workspacePath}:${payload.type}:${payload.details}`;
  if (isDuplicate(dedupeKey)) {
    return;
  }

  const workspaceName = path.basename(payload.workspacePath);

  let title: string;
  let body: string;

  switch (payload.type) {
    case 'gate':
      title = `${workspaceName}: Gate ${payload.details}`;
      body = `Project ${payload.projectId} needs approval`;
      break;
    case 'blocked':
      title = `${workspaceName}: Builder Blocked`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
    case 'error':
      title = `${workspaceName}: Build Failed`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
    case 'info':
    default:
      title = `${workspaceName}`;
      body = payload.details;
      break;
  }

  try {
    const client = getTowerClient();
    await client.sendNotification({
      type: payload.type,
      title,
      body,
      workspace: payload.workspacePath,
    });
  } catch {
    // Tower may not be running - silently ignore
  }
}

/**
 * Send notification when a gate is hit.
 */
export async function notifyGateHit(
  workspaceRoot: string,
  projectId: string,
  gateName: string
): Promise<void> {
  await sendPushNotification({
    type: 'gate',
    workspacePath: getCanonicalWorkspacePath(workspaceRoot),
    projectId,
    details: gateName,
  });
}

/**
 * Send notification when builder is blocked.
 */
export async function notifyBlocked(
  workspaceRoot: string,
  projectId: string,
  reason: string
): Promise<void> {
  await sendPushNotification({
    type: 'blocked',
    workspacePath: getCanonicalWorkspacePath(workspaceRoot),
    projectId,
    details: reason,
  });
}

/**
 * Send notification when build fails.
 */
export async function notifyError(
  workspaceRoot: string,
  projectId: string,
  error: string
): Promise<void> {
  // Only send if CODEV_PUSH_ERRORS is enabled
  if (process.env.CODEV_PUSH_ERRORS !== 'true') {
    return;
  }

  await sendPushNotification({
    type: 'error',
    workspacePath: getCanonicalWorkspacePath(workspaceRoot),
    projectId,
    details: error,
  });
}
