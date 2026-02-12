/**
 * Push notification utilities for porch events.
 * Sends notifications to the tower dashboard for real-time updates.
 */

import path from 'node:path';

export type NotificationType = 'gate' | 'blocked' | 'error' | 'info';

interface NotificationPayload {
  type: NotificationType;
  projectPath: string;
  projectId: string;
  details: string;
}

// Default tower port
const TOWER_PORT = process.env.CODEV_TOWER_PORT || '4100';

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
 * Get canonical project path from worktree path.
 * Builder worktrees are at: <project>/.builders/<id>/<branch>
 * Porch runs in these worktrees but notifications need the canonical path.
 */
function getCanonicalProjectPath(cwd: string): string {
  const builderMatch = cwd.match(/^(.+)\/.builders\/[^/]+$/);
  if (builderMatch) {
    return builderMatch[1]; // Return canonical project root
  }
  return cwd;
}

/**
 * Send a push notification to the tower dashboard.
 * Notifications are delivered via SSE to connected browsers.
 */
export async function sendPushNotification(payload: NotificationPayload): Promise<void> {
  // Dedupe by project + type + details
  const dedupeKey = `${payload.projectPath}:${payload.type}:${payload.details}`;
  if (isDuplicate(dedupeKey)) {
    return;
  }

  const projectName = path.basename(payload.projectPath);

  let title: string;
  let body: string;

  switch (payload.type) {
    case 'gate':
      title = `${projectName}: Gate ${payload.details}`;
      body = `Project ${payload.projectId} needs approval`;
      break;
    case 'blocked':
      title = `${projectName}: Builder Blocked`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
    case 'error':
      title = `${projectName}: Build Failed`;
      body = `${payload.projectId}: ${payload.details}`;
      break;
    case 'info':
    default:
      title = `${projectName}`;
      body = payload.details;
      break;
  }

  try {
    const response = await fetch(`http://localhost:${TOWER_PORT}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: payload.type,
        title,
        body,
        project: payload.projectPath,
      }),
    });

    if (!response.ok) {
      console.warn(`[notifications] Tower responded ${response.status} for ${payload.type} notification (project ${payload.projectId})`);
    }
  } catch {
    // Tower may not be running - silently ignore
  }
}

/**
 * Send notification when a gate is hit.
 */
export async function notifyGateHit(
  projectRoot: string,
  projectId: string,
  gateName: string
): Promise<void> {
  await sendPushNotification({
    type: 'gate',
    projectPath: getCanonicalProjectPath(projectRoot),
    projectId,
    details: gateName,
  });
}

/**
 * Send notification when builder is blocked.
 */
export async function notifyBlocked(
  projectRoot: string,
  projectId: string,
  reason: string
): Promise<void> {
  await sendPushNotification({
    type: 'blocked',
    projectPath: getCanonicalProjectPath(projectRoot),
    projectId,
    details: reason,
  });
}

/**
 * Send notification when build fails.
 */
export async function notifyError(
  projectRoot: string,
  projectId: string,
  error: string
): Promise<void> {
  // Only send if CODEV_PUSH_ERRORS is enabled
  if (process.env.CODEV_PUSH_ERRORS !== 'true') {
    return;
  }

  await sendPushNotification({
    type: 'error',
    projectPath: getCanonicalProjectPath(projectRoot),
    projectId,
    details: error,
  });
}
