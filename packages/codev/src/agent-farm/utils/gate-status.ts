/**
 * Gate status reader for porch YAML files.
 * Extracts pending gate information from codev/projects/<id>/status.yaml.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface GateStatus {
  hasGate: boolean;
  gateName?: string;
  builderId?: string;
  requestedAt?: string; // ISO 8601 from status.yaml gates.<name>.requested_at
}

/**
 * Read gate status from porch YAML files for a workspace.
 * Scans codev/projects/<id>/status.yaml for gates with status: pending.
 */
export function getGateStatusForWorkspace(workspacePath: string): GateStatus {
  try {
    const projectsDir = path.join(workspacePath, 'codev', 'projects');
    if (!fs.existsSync(projectsDir)) {
      return { hasGate: false };
    }

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const statusFile = path.join(projectsDir, entry.name, 'status.yaml');
      if (!fs.existsSync(statusFile)) continue;

      const content = fs.readFileSync(statusFile, 'utf-8');

      // Simple YAML parsing: look for pending gates
      // Format:
      //   gates:
      //     spec-approval:
      //       status: pending
      const gatesMatch = content.match(/^gates:\s*$/m);
      if (!gatesMatch) continue;

      const gatesSection = content.slice(gatesMatch.index! + gatesMatch[0].length);
      const lines = gatesSection.split('\n');

      let currentGate = '';
      for (const line of lines) {
        // Stop at next top-level key
        if (/^\S/.test(line) && line.trim() !== '') break;

        const gateNameMatch = line.match(/^\s{2}(\S+):\s*$/);
        if (gateNameMatch) {
          currentGate = gateNameMatch[1];
          continue;
        }

        const statusMatch = line.match(/^\s{4}status:\s*(\S+)/);
        if (statusMatch && currentGate) {
          if (statusMatch[1] === 'pending') {
            // Extract builder ID from directory name (e.g., "0099-tower-hygiene" -> "0099")
            const builderId = entry.name.match(/^(\d+)/)?.[1] || entry.name;

            // Look ahead for requested_at in remaining lines under this gate
            let requestedAt: string | undefined;
            const remaining = lines.slice(lines.indexOf(line) + 1);
            for (const nextLine of remaining) {
              // Stop at next gate name or top-level key
              if (/^\s{2}\S/.test(nextLine) || /^\S/.test(nextLine)) break;
              const reqMatch = nextLine.match(/^\s{4}requested_at:\s*'?([^'\n]+)'?/);
              if (reqMatch) {
                requestedAt = reqMatch[1].trim();
                break;
              }
            }

            return {
              hasGate: true,
              gateName: currentGate,
              builderId,
              requestedAt,
            };
          }
        }
      }
    }
  } catch {
    // Silently return no gate on errors (logged at call site if needed)
  }

  return { hasGate: false };
}
