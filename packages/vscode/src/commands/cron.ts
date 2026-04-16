import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';

interface CronTask { name: string; enabled: boolean }

export async function listCronTasks(connectionManager: ConnectionManager): Promise<void> {
  const client = connectionManager.getClient();
  if (!client || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const result = await client.request<{ tasks: CronTask[] }>('/api/cron/tasks');
  if (!result.ok || !result.data?.tasks) {
    vscode.window.showWarningMessage('Codev: No cron tasks found');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    result.data.tasks.map(t => ({
      label: t.name,
      description: t.enabled ? 'enabled' : 'disabled',
      name: t.name,
    })),
    { placeHolder: 'Cron tasks' },
  );
  if (!picked) { return; }

  const action = await vscode.window.showQuickPick(
    ['Run now', 'Enable', 'Disable'],
    { placeHolder: `Action for ${picked.name}` },
  );
  if (!action) { return; }

  const endpoint = action === 'Run now' ? 'run' : action.toLowerCase();
  await client.request(`/api/cron/tasks/${picked.name}/${endpoint}`, { method: 'POST' });
  vscode.window.showInformationMessage(`Codev: ${action} — ${picked.name}`);
}
